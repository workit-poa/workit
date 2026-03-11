import { getManagedWalletSignerContext } from "@workit-poa/auth";
import { AccountId, EthereumTransaction, TokenId } from "@hashgraph/sdk";
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
    type KmsEvmSigner,
} from "@workit-poa/hedera-kms-wallet";
import {
    Contract,
    Interface,
    type InterfaceAbi,
    getAddress,
    getBytes,
    isAddress,
    parseUnits,
    type JsonRpcProvider,
} from "ethers";
import type {
    CampaignStatusCode,
    CampaignStatusLabel,
    CampaignContributionPreview,
    LaunchpadCampaignView,
    ParticipateCampaignResult,
    SponsoredTxResult,
} from "./types";
import {
    executeCampaignContribution,
    HBAR_DECIMALS,
    prepareCampaignContribution,
    type ContributionConfig,
} from "./contribution";

const LAUNCHPAD_READ_ABI = [
    "function campaigns() view returns (address[])",
    "function workToken() view returns (address)",
];

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
];
const WHBAR_ABI = ["function deposit() payable"];

const erc20Interface = new Interface(ERC20_ABI);
const whbarInterface = new Interface(WHBAR_ABI);
const TESTNET_WHBAR_ADDRESS = "0x0000000000000000000000000000000000003ad1";
const deploymentContractCache = new Map<
    string,
    Promise<ResolvedDeploymentContracts>
>();
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
    decodeInterfaces?: Interface[];
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

interface MirrorTokenResponse {
    symbol?: unknown;
    decimals?: unknown;
}

interface MirrorTokenBalancesResponse {
    balances?: Array<{ balance?: unknown; account?: unknown }>;
}

interface MirrorAccountAllowancesResponse {
    allowances?: Array<{
        amount?: unknown;
        spender?: unknown;
        token_id?: unknown;
    }>;
}

interface MirrorAccountResponse {
    account?: unknown;
}

function accountIdToSolidityAddress(accountId: string): string {
    const solidityHex = AccountId.fromString(accountId).toSolidityAddress();
    return getAddress(`0x${solidityHex}`);
}

async function resolveDeploymentFilePath(
    chainId: string,
    contractName: string,
): Promise<string> {
    const candidates = [
        resolve(
            process.cwd(),
            "libs/contracts/deployments",
            chainId,
            `${contractName}.json`,
        ),
        resolve(
            process.cwd(),
            "../../libs/contracts/deployments",
            chainId,
            `${contractName}.json`,
        ),
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
        `Missing deployment file for ${contractName} on chainId ${chainId}. Expected one of: ${candidates.join(", ")}`,
    );
}

async function readDeploymentContractFile(
    chainId: string,
    contractName: string,
): Promise<DeploymentContractFile> {
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
        abi: payload.abi as InterfaceAbi,
    };
}

function resolveEvmProvider(): JsonRpcProvider {
    const network = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
    const rpcUrl = process.env.HEDERA_EVM_RPC_URL?.trim();
    return createHederaJsonRpcProvider({
        network,
        rpcUrl: rpcUrl && rpcUrl.length > 0 ? rpcUrl : undefined,
    });
}

function resolveSponsoredHederaNetwork(): HederaNetwork {
    const raw = (process.env.HEDERA_NETWORK || "testnet").trim().toLowerCase();
    if (raw !== "testnet" && raw !== "mainnet") {
        throw new Error(
            "HEDERA_NETWORK must be either testnet or mainnet for sponsored transactions",
        );
    }
    return raw;
}

function resolvePaymasterCredentials(): {
    operatorId: string;
    operatorKey: string;
} {
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
            "Paymaster credentials missing. Set PAYMASTER_OPERATOR_ID/PAYMASTER_OPERATOR_KEY (or OPERATOR_ID/OPERATOR_KEY).",
        );
    }

    return { operatorId, operatorKey };
}

function resolveMaxGasAllowanceHbar(): string {
    const value = process.env.PAYMASTER_MAX_GAS_ALLOWANCE_HBAR?.trim() || "2";
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error(
            "PAYMASTER_MAX_GAS_ALLOWANCE_HBAR must be a positive number",
        );
    }
    return value;
}

function resolveWhbarAddress(): string {
    const configured = process.env.LAUNCHPAD_WHBAR_ADDRESS?.trim();
    const candidate =
        configured && configured.length > 0 ? configured : TESTNET_WHBAR_ADDRESS;
    const network = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
    if ((!configured || configured.length === 0) && network !== "testnet") {
        throw new Error(
            "LAUNCHPAD_WHBAR_ADDRESS must be configured for non-testnet networks",
        );
    }
    if (isAddress(candidate)) {
        return getAddress(candidate);
    }

    try {
        const solidityHex = TokenId.fromString(candidate).toSolidityAddress();
        return getAddress(`0x${solidityHex}`);
    } catch {
        throw new Error(
            "LAUNCHPAD_WHBAR_ADDRESS must be a valid EVM address or Hedera token ID",
        );
    }
}

function resolveNativeHbarReserveTinybars(): bigint {
    const value =
        process.env.LAUNCHPAD_NATIVE_HBAR_RESERVE_HBAR?.trim() || "0.05";
    try {
        const reserve = parseUnits(value, HBAR_DECIMALS);
        if (reserve < 0n) {
            throw new Error("negative reserve");
        }
        return reserve;
    } catch {
        throw new Error(
            "LAUNCHPAD_NATIVE_HBAR_RESERVE_HBAR must be a non-negative decimal HBAR value",
        );
    }
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

    if (
        !campaignToken ||
        !fundingToken ||
        lockEpochs === undefined ||
        goal === undefined ||
        deadline === undefined
    ) {
        throw new Error("Invalid campaign listing payload");
    }

    return {
        campaignToken: getAddress(campaignToken),
        fundingToken: getAddress(fundingToken),
        lockEpochs: BigInt(lockEpochs),
        goal: BigInt(goal),
        deadline: BigInt(deadline),
    };
}

function normalizeStatus(rawStatus: unknown): CampaignStatusCode {
    if (typeof rawStatus !== "bigint" && typeof rawStatus !== "number") {
        throw new Error("Unexpected campaign status payload");
    }

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
}): Promise<{ fundingSupplyRaw: bigint; campaignSupplyRaw: bigint }> {
    try {
        const [fundingSupplyRaw, campaignSupplyRaw] = await Promise.all([
            params.campaign.fundingSupply(),
            params.campaign.campaignSupply(),
        ]);
        return {
            fundingSupplyRaw: BigInt(fundingSupplyRaw),
            campaignSupplyRaw: BigInt(campaignSupplyRaw),
        };
    } catch {
        const [fundingToken, campaignToken] = await Promise.all([
            getTokenBalanceFromHts(params.listing.fundingToken, {
                accountAddress: params.campaignAddress,
            }),
            getTokenBalanceFromHts(params.listing.campaignToken, {
                accountAddress: params.campaignAddress,
            }),
        ]);

        if (fundingToken === null || campaignToken === null) {
            throw new Error(
                `Failed to read fallback token balances from HTS for campaign ${params.campaignAddress}`,
            );
        }

        return {
            fundingSupplyRaw: fundingToken,
            campaignSupplyRaw: campaignToken,
        };
    }
}

async function getTokenMetadata(
    provider: JsonRpcProvider,
    tokenAddress: string,
): Promise<TokenMetadata> {
    const normalizedAddress = getAddress(tokenAddress);
    const isWhbar = isWhbarToken(normalizedAddress);
    const token = new Contract(normalizedAddress, ERC20_ABI, provider);
    const [metadataFromHts, symbolFromContract, decimalsFromContract] =
        await Promise.all([
            getTokenMetadataFromHts(normalizedAddress),
            token.symbol().catch(() => null),
            readTokenDecimals(token),
        ]);

    const symbolFallback = isWhbar ? "HBAR" : "TOKEN";
    const rawSymbol =
        typeof symbolFromContract === "string" &&
        symbolFromContract.trim().length > 0
            ? symbolFromContract
            : metadataFromHts?.symbol ?? symbolFallback;
    const symbol = rawSymbol.toUpperCase() === "WHBAR" ? "HBAR" : rawSymbol;
    const decimals =
        decimalsFromContract ??
        metadataFromHts?.decimals ??
        (isWhbar ? 8 : 18);

    return {
        address: normalizedAddress,
        symbol,
        decimals,
    };
}

function resolveMirrorNodeBaseUrl(): string | null {
    const configured =
        process.env.HEDERA_MIRROR_NODE_URL?.trim() ||
        process.env.HEDERA_MIRROR_REST_URL?.trim();
    if (configured) {
        return configured.replace(/\/+$/, "");
    }

    const network = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
    if (network === "mainnet")
        return "https://mainnet-public.mirrornode.hedera.com";
    if (network === "testnet") return "https://testnet.mirrornode.hedera.com";
    if (network === "previewnet")
        return "https://previewnet.mirrornode.hedera.com";
    return null;
}

function parseMirrorAmount(value: unknown): bigint | null {
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
        return BigInt(value);
    }
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value)
    ) {
        return BigInt(value);
    }
    return null;
}

function parseTokenDecimals(value: unknown): number | null {
    const numeric =
        typeof value === "bigint"
            ? Number(value)
            : typeof value === "number"
              ? value
              : typeof value === "string"
                ? Number(value)
                : Number.NaN;
    if (!Number.isInteger(numeric) || numeric < 0) {
        return null;
    }
    return numeric;
}

async function readTokenDecimals(token: Contract): Promise<number | null> {
    try {
        return parseTokenDecimals(await token.decimals());
    } catch {
        return null;
    }
}

async function readTokenBalance(
    token: Contract,
    account: string,
): Promise<bigint | null> {
    try {
        return BigInt(await token.balanceOf(account));
    } catch {
        return null;
    }
}

async function readTokenAllowance(
    token: Contract,
    owner: string,
    spender: string,
): Promise<bigint | null> {
    try {
        return BigInt(await token.allowance(owner, spender));
    } catch {
        return null;
    }
}

async function readNativeHbarBalance(
    provider: JsonRpcProvider,
    account: string,
): Promise<bigint | null> {
    try {
        return BigInt(await provider.getBalance(account));
    } catch {
        return null;
    }
}

function pickFirstNonNull(...values: Array<bigint | null>): bigint {
    for (const value of values) {
        if (value !== null) {
            return value;
        }
    }
    return 0n;
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
    const numeric =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : Number.NaN;
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function solidityAddressToEntityId(evmAddress: string): string | null {
    const normalizedAddress = getAddress(evmAddress);

    try {
        return AccountId.fromSolidityAddress(normalizedAddress).toString();
    } catch {
        return null;
    }
}

async function fetchMirrorJson<T>(path: string): Promise<T | null> {
    const mirrorBaseUrl = resolveMirrorNodeBaseUrl();
    if (!mirrorBaseUrl) return null;

    try {
        const response = await fetch(`${mirrorBaseUrl}${path}`, {
            headers: {
                accept: "application/json",
            },
        });
        if (!response.ok) return null;
        return (await response.json()) as T;
    } catch {
        return null;
    }
}

async function resolveAccountIdFromAddress(
    address: string,
): Promise<string | null> {
    const normalizedAddress = getAddress(address);
    const entityId = solidityAddressToEntityId(normalizedAddress);
    if (entityId) return entityId;

    const payload = await fetchMirrorJson<MirrorAccountResponse>(
        `/api/v1/accounts/${normalizedAddress}`,
    );
    if (
        !payload ||
        typeof payload.account !== "string" ||
        payload.account.trim().length === 0
    ) {
        return null;
    }
    return payload.account;
}

async function resolveTokenIdFromAddress(
    tokenAddress: string,
): Promise<string | null> {
    try {
        return TokenId.fromSolidityAddress(getAddress(tokenAddress)).toString();
    } catch {
        return null;
    }
}

async function getTokenMetadataFromHts(
    tokenAddress: string,
): Promise<TokenMetadata | null> {
    const tokenId = await resolveTokenIdFromAddress(tokenAddress);
    if (!tokenId) return null;

    const payload = await fetchMirrorJson<MirrorTokenResponse>(
        `/api/v1/tokens/${tokenId}`,
    );
    if (!payload) return null;

    const symbol =
        typeof payload.symbol === "string" && payload.symbol.trim().length > 0
            ? payload.symbol
            : "TOKEN";
    const decimals = parseNonNegativeInteger(payload.decimals, 18);

    return {
        address: getAddress(tokenAddress),
        symbol: symbol.toUpperCase() === "WHBAR" ? "HBAR" : symbol,
        decimals,
    };
}

async function getTokenBalanceFromHts(
    tokenAddress: string,
    owner: { accountId?: string; accountAddress?: string },
): Promise<bigint | null> {
    const tokenId = await resolveTokenIdFromAddress(tokenAddress);

    if (!tokenId) return null;

    const accountId =
        owner.accountId?.trim() ||
        (owner.accountAddress
            ? await resolveAccountIdFromAddress(owner.accountAddress)
            : null);

    if (!accountId) return null;

    const payload = await fetchMirrorJson<MirrorTokenBalancesResponse>(
        `/api/v1/tokens/${tokenId}/balances?account.id=${encodeURIComponent(accountId)}`,
    );

    if (
        !payload ||
        !Array.isArray(payload.balances) ||
        payload.balances.length === 0
    ) {
        return 0n;
    }

    return parseMirrorAmount(payload.balances[0]?.balance);
}

async function getTokenAllowanceFromHts(params: {
    tokenAddress: string;
    ownerAccountId: string;
    spenderAddress: string;
}): Promise<bigint | null> {
    const ownerAccountId = params.ownerAccountId.trim();
    if (!ownerAccountId) return null;

    const tokenId = await resolveTokenIdFromAddress(params.tokenAddress);
    if (!tokenId) return null;

    const spenderId = await resolveAccountIdFromAddress(params.spenderAddress);
    if (!spenderId) return null;

    const query = `/api/v1/accounts/${encodeURIComponent(ownerAccountId)}/allowances/tokens?token.id=${encodeURIComponent(
        tokenId,
    )}&spender.id=${encodeURIComponent(spenderId)}&limit=100`;
    const payload =
        await fetchMirrorJson<MirrorAccountAllowancesResponse>(query);
    if (!payload || !Array.isArray(payload.allowances)) {
        return null;
    }

    const match = payload.allowances.find((allowance) => {
        const tokenMatch =
            typeof allowance.token_id === "string"
                ? allowance.token_id === tokenId
                : true;
        const spenderMatch =
            typeof allowance.spender === "string"
                ? allowance.spender === spenderId
                : true;
        return tokenMatch && spenderMatch;
    });

    return parseMirrorAmount(match?.amount);
}

async function executeSponsoredTransaction(
    params: SponsoredExecutionParams,
): Promise<SponsoredExecutionResult> {
    const extractRevertData = (error: unknown): string | null => {
        const visited = new Set<unknown>();
        const stack: unknown[] = [error];

        while (stack.length > 0) {
            const value = stack.pop();
            if (!value || typeof value !== "object" || visited.has(value))
                continue;
            visited.add(value);

            const record = value as Record<string, unknown>;
            const data = record.data;
            if (
                typeof data === "string" &&
                data.startsWith("0x") &&
                data.length >= 10
            ) {
                return data;
            }

            for (const key of ["error", "info", "cause"]) {
                if (record[key] !== undefined) stack.push(record[key]);
            }
        }

        return null;
    };
    const decodeRevertData = (revertData: string): string => {
        for (const candidate of params.decodeInterfaces ?? []) {
            try {
                const parsed = candidate.parseError(revertData);
                if (parsed) {
                    const args = parsed.args
                        .map((arg) =>
                            typeof arg === "bigint"
                                ? arg.toString()
                                : String(arg),
                        )
                        .join(", ");
                    return `${parsed.name}(${args})`;
                }
            } catch {
                // Continue trying other interfaces and fallback decoders.
            }
        }

        const selector = revertData.slice(0, 10).toLowerCase();
        try {
            if (selector === "0x08c379a0") {
                const [reason] = new Interface([
                    "function Error(string)",
                ]).decodeFunctionData("Error", revertData);
                return String(reason);
            }
            if (selector === "0x4e487b71") {
                const [panicCode] = new Interface([
                    "function Panic(uint256)",
                ]).decodeFunctionData("Panic", revertData);
                return `Panic(${String(panicCode)})`;
            }
        } catch {
            // Fall through to raw selector output.
        }
        return `revertData=${revertData}`;
    };
    const decodeRevertFromError = (error: unknown): string | null => {
        const revertData = extractRevertData(error);
        if (!revertData || revertData === "0x") return null;
        return decodeRevertData(revertData);
    };
    const simulateForRevertMessage = async (): Promise<string | null> => {
        try {
            await params.provider.call({
                from: params.from,
                to: params.to,
                data: params.data,
                value: params.value ?? 0n,
            });
            return null;
        } catch (error) {
            return decodeRevertFromError(error);
        }
    };

    const network = await params.provider.getNetwork();
    const chainId = BigInt(network.chainId);
    const estimatedGas = await params.provider
        .estimateGas({
            from: params.from,
            to: params.to,
            data: params.data,
            value: params.value ?? 0n,
        })
        .catch(() => params.gasLimit);
    const paddedEstimate = (estimatedGas * 120n) / 100n;
    const gasLimit =
        paddedEstimate > params.gasLimit ? paddedEstimate : params.gasLimit;

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
            gasPrice: 0n,
        },
    });

    const tx = new EthereumTransaction()
        .setEthereumData(getBytes(signed.signedTransaction))
        .setMaxGasAllowanceHbar(resolveMaxGasAllowanceHbar());

    const response = await tx.execute(params.paymasterClient as never);
    const receipt = await response
        .getReceipt(params.paymasterClient as never)
        .catch(async (error) => {
            const message =
                error instanceof Error ? error.message : String(error);
            if (message.includes("CONTRACT_REVERT_EXECUTED")) {
                const decoded = await simulateForRevertMessage();
                throw new Error(decoded ?? "CONTRACT_REVERT_EXECUTED");
            }
            throw error;
        });
    const transactionId = response.transactionId.toString();
    const receiptStatus = receipt.status.toString();

    if (receiptStatus !== "SUCCESS") {
        const decoded = await simulateForRevertMessage();
        throw new Error(decoded ?? receiptStatus);
    }

    const record = await response
        .getRecord(params.paymasterClient as never)
        .catch(() => null);
    const revertReason = record?.contractFunctionResult?.errorMessage?.trim();
    if (revertReason) {
        throw new Error(revertReason);
    }

    return {
        transactionId,
        mirrorLink: mirrorLinkForTransaction(
            params.hederaNetwork,
            transactionId,
        ),
    };
}

async function resolveDeploymentContracts(
    provider: JsonRpcProvider,
): Promise<ResolvedDeploymentContracts> {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId).toString();
    const cached = deploymentContractCache.get(chainId);
    if (cached) {
        return cached;
    }

    const request = (async (): Promise<ResolvedDeploymentContracts> => {
        const [launchpad, campaign] = await Promise.all([
            readDeploymentContractFile(chainId, "Launchpad"),
            readDeploymentContractFile(chainId, "Campaign"),
        ]);

        return {
            launchpadAddress: launchpad.address,
            launchpadAbi: launchpad.abi,
            campaignAbi: campaign.abi,
            campaignInterface: new Interface(campaign.abi),
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

export async function getLaunchpadCampaigns(): Promise<
    LaunchpadCampaignView[]
> {
    const provider = resolveEvmProvider();
    const contracts = await resolveDeploymentContracts(provider);

    const launchpad = new Contract(
        contracts.launchpadAddress,
        contracts.launchpadAbi.length > 0
            ? contracts.launchpadAbi
            : LAUNCHPAD_READ_ABI,
        provider,
    );
    const [campaignAddresses, workTokenAddressRaw] = await Promise.all([
        launchpad.campaigns(),
        launchpad.workToken(),
    ]);
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
        (campaignAddresses as string[]).map(async (rawCampaignAddress) => {
            const campaignAddress = getAddress(rawCampaignAddress);
            const campaign = new Contract(
                campaignAddress,
                contracts.campaignAbi,
                provider,
            );

            let listingRaw: unknown;
            let statusRaw: unknown;
            try {
                [listingRaw, statusRaw] = await Promise.all([
                    campaign.listing(),
                    campaign.status(),
                ]);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                throw new Error(
                    `Failed to read campaign ${campaignAddress}: ${message}`,
                );
            }

            const listing = normalizeListing(listingRaw);
            const status = normalizeStatus(statusRaw);
            const { fundingSupplyRaw, campaignSupplyRaw } =
                await readCampaignSuppliesWithFallback({
                    campaign,
                    campaignAddress,
                    listing,
                });
            const statusLabel = getStatusLabel(status);
            const deadlineUnix = Number(listing.deadline);

            const [fundingToken, campaignToken] = await Promise.all([
                getCachedTokenMetadata(listing.fundingToken),
                getCachedTokenMetadata(listing.campaignToken),
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
                    isWorkToken: fundingToken.address === workTokenAddress,
                },
                campaignToken: {
                    ...campaignToken,
                    isWorkToken: campaignToken.address === workTokenAddress,
                },
            } satisfies LaunchpadCampaignView;
        }),
    );

    const campaigns: LaunchpadCampaignView[] = [];
    for (const result of campaignResults) {
        if (result.status === "fulfilled") {
            campaigns.push(result.value);
            continue;
        }

        const reason =
            result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
        if (!warnedCampaignReadFailures.has(reason)) {
            warnedCampaignReadFailures.add(reason);
            console.warn(`[launchpad] Skipping unreadable campaign: ${reason}`);
        }
    }

    return campaigns.sort((a, b) => a.deadlineUnix - b.deadlineUnix);
}

async function resolveCampaignFundingReadContext(params: {
    provider: JsonRpcProvider;
    tokenAddress: string;
    campaignAddress: string;
    signerAccountId: string;
    participantEvmAddress: string;
    participantContractAddress: string;
}): Promise<{ whbarBalance: bigint; nativeHbarBalance: bigint; allowance: bigint }> {
    const token = new Contract(params.tokenAddress, ERC20_ABI, params.provider);
    const [ownerAccountIdForContractAddress, ownerAccountIdForEvmAddress] =
        await Promise.all([
            resolveAccountIdFromAddress(params.participantContractAddress),
            resolveAccountIdFromAddress(params.participantEvmAddress),
        ]);

    const [
        balanceForEvmAddressOnChain,
        balanceForContractAddressOnChain,
        balanceForAccountId,
        balanceForEvmAddress,
        balanceForContractAddress,
        nativeForEvmAddress,
        nativeForContractAddress,
        allowanceForEvmAddressOnChain,
        allowanceForContractAddressOnChain,
        allowanceForAccountIdFromHts,
        allowanceForContractAddressFromHts,
        allowanceForEvmAddressFromHts,
    ] = await Promise.all([
        readTokenBalance(token, params.participantEvmAddress),
        readTokenBalance(token, params.participantContractAddress),
        getTokenBalanceFromHts(params.tokenAddress, {
            accountId: params.signerAccountId,
        }),
        getTokenBalanceFromHts(params.tokenAddress, {
            accountAddress: params.participantEvmAddress,
        }),
        getTokenBalanceFromHts(params.tokenAddress, {
            accountAddress: params.participantContractAddress,
        }),
        readNativeHbarBalance(params.provider, params.participantEvmAddress),
        readNativeHbarBalance(params.provider, params.participantContractAddress),
        readTokenAllowance(
            token,
            params.participantEvmAddress,
            params.campaignAddress,
        ),
        readTokenAllowance(
            token,
            params.participantContractAddress,
            params.campaignAddress,
        ),
        getTokenAllowanceFromHts({
            tokenAddress: params.tokenAddress,
            ownerAccountId: params.signerAccountId,
            spenderAddress: params.campaignAddress,
        }),
        ownerAccountIdForContractAddress
            ? getTokenAllowanceFromHts({
                  tokenAddress: params.tokenAddress,
                  ownerAccountId: ownerAccountIdForContractAddress,
                  spenderAddress: params.campaignAddress,
              })
            : Promise.resolve(null),
        ownerAccountIdForEvmAddress
            ? getTokenAllowanceFromHts({
                  tokenAddress: params.tokenAddress,
                  ownerAccountId: ownerAccountIdForEvmAddress,
                  spenderAddress: params.campaignAddress,
              })
            : Promise.resolve(null),
    ]);

    return {
        whbarBalance: pickFirstNonNull(
            balanceForEvmAddressOnChain,
            balanceForContractAddressOnChain,
            balanceForAccountId,
            balanceForEvmAddress,
            balanceForContractAddress,
        ),
        nativeHbarBalance: pickFirstNonNull(
            nativeForEvmAddress,
            nativeForContractAddress,
        ),
        allowance: pickFirstNonNull(
            allowanceForEvmAddressOnChain,
            allowanceForContractAddressOnChain,
            allowanceForAccountIdFromHts,
            allowanceForContractAddressFromHts,
            allowanceForEvmAddressFromHts,
        ),
    };
}

async function createCampaignContributionContext(params: {
    userId: string;
    campaignAddress: string;
    amount: string;
}): Promise<{
    provider: JsonRpcProvider;
    contracts: ResolvedDeploymentContracts;
    signerContext: Awaited<ReturnType<typeof getManagedWalletSignerContext>>;
    normalizedCampaignAddress: string;
    listing: CampaignListing;
    amountInput: string;
    amountRaw: bigint;
    fundingTokenDecimals: number;
}> {
    const normalizedCampaignAddress = getAddress(params.campaignAddress);
    const amountInput = params.amount.trim();
    if (!amountInput) {
        throw new Error("Amount is required");
    }

    const provider = resolveEvmProvider();
    const contracts = await resolveDeploymentContracts(provider);
    const campaign = new Contract(
        normalizedCampaignAddress,
        contracts.campaignAbi,
        provider,
    );
    const [listingRaw, statusRaw] = await Promise.all([
        campaign.listing(),
        campaign.status(),
    ]);
    const listing = normalizeListing(listingRaw);
    const status = normalizeStatus(statusRaw);
    const fundingToken = new Contract(listing.fundingToken, ERC20_ABI, provider);

    if (status !== 1) {
        throw new Error("Campaign is not currently accepting contributions");
    }

    const currentUnix = Math.floor(Date.now() / 1000);
    if (currentUnix >= Number(listing.deadline)) {
        throw new Error("Campaign deadline has passed");
    }

    const [fundingTokenMetadata, fundingTokenDecimalsFromContract] =
        await Promise.all([
            getTokenMetadataFromHts(listing.fundingToken),
            readTokenDecimals(fundingToken),
        ]);
    const fundingTokenDecimals =
        fundingTokenDecimalsFromContract ??
        fundingTokenMetadata?.decimals ??
        (isWhbarToken(listing.fundingToken) ? HBAR_DECIMALS : 18);

    let amountRaw: bigint;
    try {
        amountRaw = parseUnits(amountInput, fundingTokenDecimals);
    } catch {
        throw new Error(
            `Invalid amount for token with ${fundingTokenDecimals} decimals`,
        );
    }
    if (amountRaw <= 0n) {
        throw new Error("Amount must be greater than zero");
    }

    const signerContext = await getManagedWalletSignerContext(params.userId);

    return {
        provider,
        contracts,
        signerContext,
        normalizedCampaignAddress,
        listing,
        amountInput,
        amountRaw,
        fundingTokenDecimals,
    };
}

async function buildContributionConfig(params: {
    userId: string;
    campaignAddress: string;
    amount: string;
}): Promise<{
    config: ContributionConfig;
    provider: JsonRpcProvider;
    contracts: ResolvedDeploymentContracts;
    listing: CampaignListing;
    signerContext: Awaited<ReturnType<typeof getManagedWalletSignerContext>>;
    participantEvmAddress: string;
    participantContractAddress: string;
    kms: ReturnType<typeof createKmsClientFromEnv>;
    hederaNetwork: HederaNetwork;
    paymasterClient: ReturnType<typeof createHederaClient>;
}> {
    const contributionContext = await createCampaignContributionContext(params);
    const kms = createKmsClientFromEnv();

    const hederaNetwork = resolveSponsoredHederaNetwork();
    const { operatorId, operatorKey } = resolvePaymasterCredentials();
    const paymasterClient = createHederaClient({
        network: hederaNetwork,
        operatorId,
        operatorKey,
    });

    const signer: KmsEvmSigner = await createKmsEvmSigner({
        kms,
        keyId: contributionContext.signerContext.kmsKeyId,
        provider: contributionContext.provider,
    });
    const participantEvmAddress = await signer.getAddress();
    const participantContractAddress = accountIdToSolidityAddress(
        contributionContext.signerContext.hederaAccountId,
    );

    return {
        config: {
            campaignAddress: contributionContext.normalizedCampaignAddress,
            fundingToken: contributionContext.listing.fundingToken,
            amountInput: contributionContext.amountInput,
            amountRaw: contributionContext.amountRaw,
            fundingTokenDecimals: contributionContext.fundingTokenDecimals,
            recipient: participantContractAddress,
            nativeHbarReserveRaw: resolveNativeHbarReserveTinybars(),
            isWhbarFundingToken: isWhbarToken(
                contributionContext.listing.fundingToken,
            ),
        },
        provider: contributionContext.provider,
        contracts: contributionContext.contracts,
        listing: contributionContext.listing,
        signerContext: contributionContext.signerContext,
        participantEvmAddress,
        participantContractAddress,
        kms,
        hederaNetwork,
        paymasterClient,
    };
}

function createContributionReaders(ctx: {
    provider: JsonRpcProvider;
    listing: CampaignListing;
    config: ContributionConfig;
    signerContext: Awaited<ReturnType<typeof getManagedWalletSignerContext>>;
    participantEvmAddress: string;
    participantContractAddress: string;
}): {
    readWhbarBalance: () => Promise<bigint>;
    readNativeHbarBalance: () => Promise<bigint>;
    readAllowance: () => Promise<bigint>;
} {
    let snapshotPromise: Promise<{
        whbarBalance: bigint;
        nativeHbarBalance: bigint;
        allowance: bigint;
    }> | null = null;

    const loadSnapshot = async () => {
        if (!snapshotPromise) {
            snapshotPromise = resolveCampaignFundingReadContext({
                provider: ctx.provider,
                tokenAddress: ctx.listing.fundingToken,
                campaignAddress: ctx.config.campaignAddress,
                signerAccountId: ctx.signerContext.hederaAccountId,
                participantEvmAddress: ctx.participantEvmAddress,
                participantContractAddress: ctx.participantContractAddress,
            });
        }

        try {
            return await snapshotPromise;
        } finally {
            snapshotPromise = null;
        }
    };

    return {
        readWhbarBalance: async () => (await loadSnapshot()).whbarBalance,
        readNativeHbarBalance: async () =>
            (await loadSnapshot()).nativeHbarBalance,
        readAllowance: async () => (await loadSnapshot()).allowance,
    };
}

export async function previewCampaignContribution(params: {
    userId: string;
    campaignAddress: string;
    amount: string;
}): Promise<CampaignContributionPreview> {
    const ctx = await buildContributionConfig(params);

    try {
        const reads = createContributionReaders(ctx);
        return await prepareCampaignContribution({
            config: ctx.config,
            reads,
        });
    } finally {
        ctx.kms.destroy();
        ctx.paymasterClient.close();
    }
}

export async function participateInCampaign(params: {
    userId: string;
    campaignAddress: string;
    amount: string;
}): Promise<ParticipateCampaignResult> {
    const ctx = await buildContributionConfig(params);

    try {
        let nonce = await ctx.provider.getTransactionCount(
            ctx.participantEvmAddress,
            "pending",
        );

        const result = await executeCampaignContribution({
            config: ctx.config,
            runtime: {
                reads: createContributionReaders(ctx),
                writes: {
                    wrapHbar: async (amount) => {
                        const wrapData = whbarInterface.encodeFunctionData("deposit");
                        const wrapResult = await executeSponsoredTransaction({
                            paymasterClient: ctx.paymasterClient,
                            hederaNetwork: ctx.hederaNetwork,
                            kmsKeyId: ctx.signerContext.kmsKeyId,
                            kms: ctx.kms,
                            provider: ctx.provider,
                            nonce,
                            from: ctx.participantEvmAddress,
                            to: ctx.listing.fundingToken,
                            data: wrapData,
                            gasLimit: 180_000n,
                            value: amount,
                        });
                        nonce += 1;
                        return {
                            type: "wrap_hbar",
                            transactionId: wrapResult.transactionId,
                            mirrorLink: wrapResult.mirrorLink,
                        };
                    },
                    approveFundingToken: async (amount) => {
                        const approveData = erc20Interface.encodeFunctionData("approve", [
                            ctx.config.campaignAddress,
                            amount,
                        ]);
                        const approveResult = await executeSponsoredTransaction({
                            paymasterClient: ctx.paymasterClient,
                            hederaNetwork: ctx.hederaNetwork,
                            kmsKeyId: ctx.signerContext.kmsKeyId,
                            kms: ctx.kms,
                            provider: ctx.provider,
                            nonce,
                            from: ctx.participantEvmAddress,
                            to: ctx.listing.fundingToken,
                            data: approveData,
                            gasLimit: 150_000n,
                            decodeInterfaces: [erc20Interface],
                        });
                        nonce += 1;
                        return {
                            type: "approve",
                            transactionId: approveResult.transactionId,
                            mirrorLink: approveResult.mirrorLink,
                        };
                    },
                    contribute: async (amount, recipient) => {
                        const contributeData =
                            ctx.contracts.campaignInterface.encodeFunctionData(
                                "contribute",
                                [amount, recipient],
                            );
                        const contributeResult = await executeSponsoredTransaction({
                            paymasterClient: ctx.paymasterClient,
                            hederaNetwork: ctx.hederaNetwork,
                            kmsKeyId: ctx.signerContext.kmsKeyId,
                            kms: ctx.kms,
                            provider: ctx.provider,
                            nonce,
                            from: ctx.participantEvmAddress,
                            to: ctx.config.campaignAddress,
                            data: contributeData,
                            gasLimit: 450_000n,
                            decodeInterfaces: [ctx.contracts.campaignInterface],
                        });
                        nonce += 1;
                        return {
                            type: "contribute",
                            transactionId: contributeResult.transactionId,
                            mirrorLink: contributeResult.mirrorLink,
                        };
                    },
                },
            },
        });

        return {
            preview: result.preview,
            campaignAddress: ctx.config.campaignAddress,
            participantEvmAddress: ctx.participantContractAddress,
            amount: ctx.config.amountInput,
            amountRaw: ctx.config.amountRaw.toString(),
            fundingToken: ctx.listing.fundingToken,
            transactions: result.transactions,
        };
    } finally {
        ctx.kms.destroy();
        ctx.paymasterClient.close();
    }
}
