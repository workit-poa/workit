import { getManagedWalletSignerContext } from "@workit-poa/auth";
import { AccountId, EthereumTransaction } from "@hashgraph/sdk";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createHederaClient,
  createHederaJsonRpcProvider,
  createKmsClientFromEnv,
  createKmsEvmSigner,
  mirrorLinkForTransaction,
  parseHederaEvmNetwork,
  signEvmTransactionWithKmsWallet,
  type HederaNetwork,
  type KmsEvmSigner
} from "@workit-poa/hedera-kms-wallet";
import {
  Contract,
  Interface,
  type InterfaceAbi,
  MaxUint256,
  getAddress,
  getBytes,
  isAddress,
  parseUnits,
  type JsonRpcProvider
} from "ethers";
import type { CampaignStatusCode, CampaignStatusLabel, LaunchpadCampaignView, ParticipateCampaignResult, SponsoredTxResult } from "./types";

const LAUNCHPAD_READ_ABI = [
  "function campaigns() view returns (address[])",
  "function workToken() view returns (address)"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const WHBAR_ABI = ["function deposit() payable"];

const erc20Interface = new Interface(ERC20_ABI);
const whbarInterface = new Interface(WHBAR_ABI);
const TESTNET_WHBAR_ADDRESS = "0x0000000000000000000000000000000000003ad1";
const deploymentContractCache = new Map<string, Promise<ResolvedDeploymentContracts>>();
const warnedCampaignReadFailures = new Set<string>();

interface TokenMetadata {
  address: string;
  symbol: string;
  decimals: number;
}

interface CampaignListing {
  campaignToken: string;
  fundingToken: string;
  lockEpochs: bigint;
  goal: bigint;
  deadline: bigint;
}

interface SponsoredExecutionResult {
  transactionId: string;
  mirrorLink: string;
}

interface SponsoredExecutionParams {
  paymasterClient: ReturnType<typeof createHederaClient>;
  hederaNetwork: HederaNetwork;
  kmsKeyId: string;
  kms: ReturnType<typeof createKmsClientFromEnv>;
  provider: JsonRpcProvider;
  nonce: number;
  from: string;
  to: string;
  data: string;
  gasLimit: bigint;
  value?: bigint;
}

interface DeploymentContractFile {
  address: string;
  abi: InterfaceAbi;
}

interface ResolvedDeploymentContracts {
  launchpadAddress: string;
  launchpadAbi: InterfaceAbi;
  campaignAbi: InterfaceAbi;
  campaignInterface: Interface;
}

function accountIdToSolidityAddress(accountId: string): string {
  const solidityHex = AccountId.fromString(accountId).toSolidityAddress();
  return getAddress(`0x${solidityHex}`);
}

async function resolveDeploymentFilePath(chainId: string, contractName: string): Promise<string> {
  const candidates = [
    resolve(process.cwd(), "libs/contracts/deployments", chainId, `${contractName}.json`),
    resolve(process.cwd(), "../../libs/contracts/deployments", chainId, `${contractName}.json`)
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching candidate paths.
    }
  }

  throw new Error(
    `Missing deployment file for ${contractName} on chainId ${chainId}. Expected one of: ${candidates.join(", ")}`
  );
}

async function readDeploymentContractFile(chainId: string, contractName: string): Promise<DeploymentContractFile> {
  const filePath = await resolveDeploymentFilePath(chainId, contractName);
  const raw = await readFile(filePath, "utf8");
  const payload = JSON.parse(raw) as { address?: unknown; abi?: unknown };

  if (typeof payload.address !== "string" || !isAddress(payload.address)) {
    throw new Error(`Invalid address in deployment file ${filePath}`);
  }
  if (!Array.isArray(payload.abi)) {
    throw new Error(`Invalid abi in deployment file ${filePath}`);
  }

  return {
    address: getAddress(payload.address),
    abi: payload.abi as InterfaceAbi
  };
}

function resolveEvmProvider(): JsonRpcProvider {
  const network = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
  const rpcUrl = process.env.HEDERA_EVM_RPC_URL?.trim();
  return createHederaJsonRpcProvider({
    network,
    rpcUrl: rpcUrl && rpcUrl.length > 0 ? rpcUrl : undefined
  });
}

function resolveSponsoredHederaNetwork(): HederaNetwork {
  const raw = (process.env.HEDERA_NETWORK || "testnet").trim().toLowerCase();
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new Error("HEDERA_NETWORK must be either testnet or mainnet for sponsored transactions");
  }
  return raw;
}

function resolvePaymasterCredentials(): { operatorId: string; operatorKey: string } {
  const operatorId =
    process.env.PAYMASTER_OPERATOR_ID?.trim() ||
    process.env.OPERATOR_ID?.trim() ||
    process.env.HEDERA_OPERATOR_ID?.trim();
  const operatorKey =
    process.env.PAYMASTER_OPERATOR_KEY?.trim() ||
    process.env.OPERATOR_KEY?.trim() ||
    process.env.HEDERA_OPERATOR_KEY?.trim();

  if (!operatorId || !operatorKey) {
    throw new Error(
      "Paymaster credentials missing. Set PAYMASTER_OPERATOR_ID/PAYMASTER_OPERATOR_KEY (or OPERATOR_ID/OPERATOR_KEY)."
    );
  }

  return { operatorId, operatorKey };
}

function resolveMaxGasAllowanceHbar(): string {
  const value = process.env.PAYMASTER_MAX_GAS_ALLOWANCE_HBAR?.trim() || "2";
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("PAYMASTER_MAX_GAS_ALLOWANCE_HBAR must be a positive number");
  }
  return value;
}

function resolveWhbarAddress(): string {
  const configured = process.env.LAUNCHPAD_WHBAR_ADDRESS?.trim();
  const address = configured && configured.length > 0 ? configured : TESTNET_WHBAR_ADDRESS;
  if (!isAddress(address)) {
    throw new Error("LAUNCHPAD_WHBAR_ADDRESS must be a valid EVM address");
  }
  return getAddress(address);
}

function isWhbarToken(tokenAddress: string): boolean {
  return getAddress(tokenAddress) === resolveWhbarAddress();
}

function getStatusLabel(status: CampaignStatusCode): CampaignStatusLabel {
  if (status === 0) return "Pending";
  if (status === 1) return "Funding";
  if (status === 2) return "Failed";
  return "Success";
}

function normalizeListing(raw: unknown): CampaignListing {
  const tuple = raw as {
    campaignToken?: string;
    fundingToken?: string;
    lockEpochs?: bigint;
    goal?: bigint;
    deadline?: bigint;
    0?: string;
    1?: string;
    2?: bigint;
    3?: bigint;
    4?: bigint;
  };

  const campaignToken = tuple.campaignToken ?? tuple[0];
  const fundingToken = tuple.fundingToken ?? tuple[1];
  const lockEpochs = tuple.lockEpochs ?? tuple[2];
  const goal = tuple.goal ?? tuple[3];
  const deadline = tuple.deadline ?? tuple[4];

  if (!campaignToken || !fundingToken || lockEpochs === undefined || goal === undefined || deadline === undefined) {
    throw new Error("Invalid campaign listing payload");
  }

  return {
    campaignToken: getAddress(campaignToken),
    fundingToken: getAddress(fundingToken),
    lockEpochs: BigInt(lockEpochs),
    goal: BigInt(goal),
    deadline: BigInt(deadline)
  };
}

function normalizeStatus(rawStatus: bigint | number): CampaignStatusCode {
  const status = Number(rawStatus);
  if (status !== 0 && status !== 1 && status !== 2 && status !== 3) {
    throw new Error(`Unexpected campaign status value: ${status}`);
  }
  return status;
}

async function readCampaignSuppliesWithFallback(params: {
  campaign: Contract;
  campaignAddress: string;
  listing: CampaignListing;
  provider: JsonRpcProvider;
}): Promise<{ fundingSupplyRaw: bigint; campaignSupplyRaw: bigint }> {
  try {
    const [fundingSupplyRaw, campaignSupplyRaw] = await Promise.all([
      params.campaign.fundingSupply(),
      params.campaign.campaignSupply()
    ]);
    return {
      fundingSupplyRaw: BigInt(fundingSupplyRaw),
      campaignSupplyRaw: BigInt(campaignSupplyRaw)
    };
  } catch {
    const [fundingToken, campaignToken] = await Promise.all([
      new Contract(params.listing.fundingToken, ERC20_ABI, params.provider).balanceOf(params.campaignAddress),
      new Contract(params.listing.campaignToken, ERC20_ABI, params.provider).balanceOf(params.campaignAddress)
    ]);
    return {
      fundingSupplyRaw: BigInt(fundingToken),
      campaignSupplyRaw: BigInt(campaignToken)
    };
  }
}

async function getTokenMetadata(provider: JsonRpcProvider, tokenAddress: string): Promise<TokenMetadata> {
  const token = new Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, decimalsRaw] = await Promise.all([
    token.symbol().catch(() => "TOKEN"),
    token.decimals().catch(() => 18)
  ]);

  const decimals = Number(decimalsRaw);
  const normalizedAddress = getAddress(tokenAddress);
  if (isWhbarToken(normalizedAddress)) {
    return {
      address: normalizedAddress,
      symbol: "HBAR",
      decimals: 8
    };
  }

  return {
    address: normalizedAddress,
    symbol: typeof symbol === "string" && symbol.trim().length > 0 ? symbol : "TOKEN",
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18
  };
}

async function executeSponsoredTransaction(params: SponsoredExecutionParams): Promise<SponsoredExecutionResult> {
  const network = await params.provider.getNetwork();
  const chainId = BigInt(network.chainId);
  const estimatedGas = await params.provider
    .estimateGas({
      from: params.from,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n
    })
    .catch(() => params.gasLimit);
  const paddedEstimate = (estimatedGas * 120n) / 100n;
  const gasLimit = paddedEstimate > params.gasLimit ? paddedEstimate : params.gasLimit;

  const signed = await signEvmTransactionWithKmsWallet({
    kms: params.kms,
    keyId: params.kmsKeyId,
    provider: params.provider,
    transaction: {
      chainId,
      from: params.from,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      nonce: params.nonce,
      gasLimit,
      gasPrice: 0n
    }
  });

  const tx = new EthereumTransaction()
    .setEthereumData(getBytes(signed.signedTransaction))
    .setMaxGasAllowanceHbar(resolveMaxGasAllowanceHbar());

  const response = await tx.execute(params.paymasterClient as never);
  const receipt = await response.getReceipt(params.paymasterClient as never);
  const transactionId = response.transactionId.toString();
  const receiptStatus = receipt.status.toString();

  if (receiptStatus !== "SUCCESS") {
    throw new Error(`Sponsored transaction failed with status ${receiptStatus}`);
  }

  const record = await response.getRecord(params.paymasterClient as never).catch(() => null);
  const revertReason = record?.contractFunctionResult?.errorMessage?.trim();
  if (revertReason) {
    throw new Error(`Contract reverted: ${revertReason}`);
  }

  return {
    transactionId,
    mirrorLink: mirrorLinkForTransaction(params.hederaNetwork, transactionId)
  };
}

async function resolveDeploymentContracts(provider: JsonRpcProvider): Promise<ResolvedDeploymentContracts> {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId).toString();
  const cached = deploymentContractCache.get(chainId);
  if (cached) {
    return cached;
  }

  const request = (async (): Promise<ResolvedDeploymentContracts> => {
    const [launchpad, campaign] = await Promise.all([
      readDeploymentContractFile(chainId, "Launchpad"),
      readDeploymentContractFile(chainId, "Campaign")
    ]);

    return {
      launchpadAddress: launchpad.address,
      launchpadAbi: launchpad.abi,
      campaignAbi: campaign.abi,
      campaignInterface: new Interface(campaign.abi)
    };
  })();

  deploymentContractCache.set(chainId, request);
  try {
    return await request;
  } catch (error) {
    deploymentContractCache.delete(chainId);
    throw error;
  }
}

export async function getLaunchpadCampaigns(): Promise<LaunchpadCampaignView[]> {
  const provider = resolveEvmProvider();
  const contracts = await resolveDeploymentContracts(provider);

  const launchpad = new Contract(contracts.launchpadAddress, contracts.launchpadAbi.length > 0 ? contracts.launchpadAbi : LAUNCHPAD_READ_ABI, provider);
  const [campaignAddresses, workTokenAddressRaw] = await Promise.all([launchpad.campaigns(), launchpad.workToken()]);
  const workTokenAddress = getAddress(workTokenAddressRaw);
  const tokenCache = new Map<string, Promise<TokenMetadata>>();

  const getCachedTokenMetadata = (tokenAddress: string) => {
    const address = getAddress(tokenAddress);
    const cached = tokenCache.get(address);
    if (cached) return cached;

    const request = getTokenMetadata(provider, address);
    tokenCache.set(address, request);
    return request;
  };

  const nowUnix = Math.floor(Date.now() / 1000);

  const campaignResults = await Promise.allSettled(
    (campaignAddresses as string[]).map(async rawCampaignAddress => {
      const campaignAddress = getAddress(rawCampaignAddress);
      const campaign = new Contract(campaignAddress, contracts.campaignAbi, provider);

      let listingRaw: unknown;
      let statusRaw: unknown;
      try {
        [listingRaw, statusRaw] = await Promise.all([
          campaign.listing(),
          campaign.status()
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read campaign ${campaignAddress}: ${message}`);
      }

      const listing = normalizeListing(listingRaw);
      const status = normalizeStatus(statusRaw);
      const { fundingSupplyRaw, campaignSupplyRaw } = await readCampaignSuppliesWithFallback({
        campaign,
        campaignAddress,
        listing,
        provider
      });
      const statusLabel = getStatusLabel(status);
      const deadlineUnix = Number(listing.deadline);

      const [fundingToken, campaignToken] = await Promise.all([
        getCachedTokenMetadata(listing.fundingToken),
        getCachedTokenMetadata(listing.campaignToken)
      ]);

      return {
        campaignAddress,
        status,
        statusLabel,
        deadlineUnix,
        isParticipatable: status === 1 && nowUnix < deadlineUnix,
        goal: listing.goal.toString(),
        fundingSupply: fundingSupplyRaw.toString(),
        campaignSupply: campaignSupplyRaw.toString(),
        fundingToken: {
          ...fundingToken,
          isWorkToken: fundingToken.address === workTokenAddress
        },
        campaignToken: {
          ...campaignToken,
          isWorkToken: campaignToken.address === workTokenAddress
        }
      } satisfies LaunchpadCampaignView;
    })
  );
  const campaigns: LaunchpadCampaignView[] = [];
  for (const result of campaignResults) {
    if (result.status === "fulfilled") {
      campaigns.push(result.value);
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    if (!warnedCampaignReadFailures.has(reason)) {
      warnedCampaignReadFailures.add(reason);
      console.warn(`[launchpad] Skipping unreadable campaign: ${reason}`);
    }
  }

  return campaigns.sort((a, b) => a.deadlineUnix - b.deadlineUnix);
}

export async function participateInCampaign(params: {
  userId: string;
  campaignAddress: string;
  amount: string;
}): Promise<ParticipateCampaignResult> {
  const normalizedCampaignAddress = getAddress(params.campaignAddress);
  const amountInput = params.amount.trim();
  if (!amountInput) {
    throw new Error("Amount is required");
  }

  const provider = resolveEvmProvider();
  const contracts = await resolveDeploymentContracts(provider);
  const campaign = new Contract(normalizedCampaignAddress, contracts.campaignAbi, provider);
  const [listingRaw, statusRaw] = await Promise.all([campaign.listing(), campaign.status()]);
  const listing = normalizeListing(listingRaw);
  const status = normalizeStatus(statusRaw);

  if (status !== 1) {
    throw new Error("Campaign is not currently accepting contributions");
  }

  const currentUnix = Math.floor(Date.now() / 1000);
  if (currentUnix >= Number(listing.deadline)) {
    throw new Error("Campaign deadline has passed");
  }

  const fundingToken = new Contract(listing.fundingToken, ERC20_ABI, provider);
  const fundingTokenDecimalsRaw = await fundingToken.decimals().catch(() => 18);
  const fundingTokenDecimals = Number(fundingTokenDecimalsRaw);

  let amountRaw: bigint;
  try {
    amountRaw = parseUnits(amountInput, fundingTokenDecimals);
  } catch {
    throw new Error(`Invalid amount for token with ${fundingTokenDecimals} decimals`);
  }
  if (amountRaw <= 0n) {
    throw new Error("Amount must be greater than zero");
  }

  const signerContext = await getManagedWalletSignerContext(params.userId);
  const kms = createKmsClientFromEnv();

  const hederaNetwork = resolveSponsoredHederaNetwork();
  const { operatorId, operatorKey } = resolvePaymasterCredentials();
  const paymasterClient = createHederaClient({
    network: hederaNetwork,
    operatorId,
    operatorKey
  });

  try {
    const signer: KmsEvmSigner = await createKmsEvmSigner({
      kms,
      keyId: signerContext.kmsKeyId,
      provider
    });
    const participantEvmAddress = await signer.getAddress();
    const participantContractAddress = accountIdToSolidityAddress(signerContext.hederaAccountId);
    const acceptsHbarFunding = isWhbarToken(listing.fundingToken);

    const transactions: SponsoredTxResult[] = [];
    let nonce = await provider.getTransactionCount(participantEvmAddress, "pending");

    if (acceptsHbarFunding) {
      const whbarToken = new Contract(listing.fundingToken, ERC20_ABI, provider);
      const [balanceForEvmAddress, balanceForContractAddress] = await Promise.all([
        whbarToken.balanceOf(participantEvmAddress).then((value: bigint) => BigInt(value)).catch(() => null),
        whbarToken.balanceOf(participantContractAddress).then((value: bigint) => BigInt(value)).catch(() => null)
      ]);
      const availableWhbar = balanceForEvmAddress ?? balanceForContractAddress ?? 0n;

      if (availableWhbar < amountRaw) {
        const wrapAmount = amountRaw - availableWhbar;
        const wrapData = whbarInterface.encodeFunctionData("deposit");
        const wrapResult = await executeSponsoredTransaction({
          paymasterClient,
          hederaNetwork,
          kmsKeyId: signerContext.kmsKeyId,
          kms,
          provider,
          nonce,
          from: participantEvmAddress,
          to: listing.fundingToken,
          data: wrapData,
          gasLimit: 180_000n,
          value: wrapAmount
        });

        transactions.push({
          type: "wrap_hbar",
          transactionId: wrapResult.transactionId,
          mirrorLink: wrapResult.mirrorLink
        });
        nonce += 1;
      }
    }

    let allowance = 0n;
    try {
      allowance = BigInt(await fundingToken.allowance(participantEvmAddress, normalizedCampaignAddress));
    } catch {
      try {
        allowance = BigInt(await fundingToken.allowance(participantContractAddress, normalizedCampaignAddress));
      } catch {
        allowance = 0n;
      }
    }

    if (allowance < amountRaw) {
      const approveData = erc20Interface.encodeFunctionData("approve", [normalizedCampaignAddress, MaxUint256]);
      const approveResult = await executeSponsoredTransaction({
        paymasterClient,
        hederaNetwork,
        kmsKeyId: signerContext.kmsKeyId,
        kms,
        provider,
        nonce,
        from: participantEvmAddress,
        to: listing.fundingToken,
        data: approveData,
        gasLimit: 150_000n
      });

      transactions.push({
        type: "approve",
        transactionId: approveResult.transactionId,
        mirrorLink: approveResult.mirrorLink
      });
      nonce += 1;
    }

    const contributeData = contracts.campaignInterface.encodeFunctionData("contribute", [amountRaw, participantContractAddress]);
    const contributeResult = await executeSponsoredTransaction({
      paymasterClient,
      hederaNetwork,
      kmsKeyId: signerContext.kmsKeyId,
      kms,
      provider,
      nonce,
      from: participantEvmAddress,
      to: normalizedCampaignAddress,
      data: contributeData,
      gasLimit: 450_000n
    });

    transactions.push({
      type: "contribute",
      transactionId: contributeResult.transactionId,
      mirrorLink: contributeResult.mirrorLink
    });

    return {
      campaignAddress: normalizedCampaignAddress,
      participantEvmAddress: participantContractAddress,
      amount: amountInput,
      amountRaw: amountRaw.toString(),
      fundingToken: listing.fundingToken,
      transactions
    };
  } finally {
    kms.destroy();
    paymasterClient.close();
  }
}
