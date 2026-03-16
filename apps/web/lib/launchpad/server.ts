import { getManagedWalletSignerContext } from "@workit-poa/auth";
import {
    AccountBalanceQuery,
    AccountId,
    EthereumTransaction,
    TokenAssociateTransaction,
    TokenId,
} from "@hashgraph/sdk";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    addKmsSignatureToFrozenTransaction,
    createHederaClient,
    createHederaJsonRpcProvider,
    createKmsHederaSigner,
    createKmsClientFromEnv,
    createKmsEvmSigner,
    executeSignedTransaction,
    mirrorLinkForTransaction,
    parseHederaEvmNetwork,
    signEvmTransactionWithKmsWallet,
    type HederaNetwork,
    type KmsEvmSigner,
} from "@workit-poa/hedera-kms-wallet";
import {
    Contract,
    Interface,
    Wallet,
    type InterfaceAbi,
    getAddress,
    getBytes,
    isAddress,
    solidityPackedKeccak256,
    parseUnits,
    type JsonRpcProvider,
} from "ethers";
import type {
    CampaignStatusCode,
    CampaignStatusLabel,
    CampaignContributionPreview,
    LaunchpadCampaignView,
    ParticipateCampaignResult,
    SettleCampaignParticipationResult,
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
const erc20Interface = new Interface(ERC20_ABI);
const PAIR_FEE_FACTORY_ABI = ["function pairCreateFee() view returns (uint256)"];

const HBAR_WEI_DECIMALS = 18n;
const HBAR_TO_WEI_MULTIPLIER =
    10n ** (HBAR_WEI_DECIMALS - BigInt(HBAR_DECIMALS));
const deploymentContractCache = new Map<
    string,
    Promise<ResolvedDeploymentContracts>
>();
const warnedCampaignReadFailures = new Set<string>();
const warnedCampaignResolveFailures = new Set<string>();
const pairCreateFeeCache = new Map<string, Promise<bigint>>();

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

interface LaunchpadResolverContext {
    signer: Wallet;
    address: string;
}

interface SponsoredExecutionResult {
    transactionId: string;
    mirrorLink: string;
}
type HederaClient = ReturnType<typeof createHederaClient>;

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
    whbarAddress: string;
    whbarInterface: Interface;
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

interface MirrorExchangeRateResponse {
    current_rate?: {
        cent_equivalent?: unknown;
        hbar_equivalent?: unknown;
    };
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

function parseEvmPrivateKey(raw: string | undefined): string | null {
    if (!raw) return null;
    const value = raw.trim();
    if (!value) return null;
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        return null;
    }
    return `0x${hex}`;
}

function resolveLaunchpadResolver(
    provider: JsonRpcProvider,
): LaunchpadResolverContext | null {
    const preferred = parseEvmPrivateKey(
        process.env.LAUNCHPAD_RESOLVER_PRIVATE_KEY,
    );
    const fallback = parseEvmPrivateKey(
        process.env.PAYMASTER_OPERATOR_KEY ??
            process.env.OPERATOR_KEY ??
            process.env.HEDERA_OPERATOR_KEY,
    );
    const privateKey = preferred ?? fallback;
    if (!privateKey) return null;

    const signer = new Wallet(privateKey, provider);
    return {
        signer,
        address: getAddress(signer.address),
    };
}

async function tryResolveCampaignOnRead(params: {
    campaignAddress: string;
    contracts: ResolvedDeploymentContracts;
    provider: JsonRpcProvider;
    resolver: LaunchpadResolverContext | null;
    nowUnix: number;
}): Promise<void> {
    if (!params.resolver) return;

    const readOnlyCampaign = new Contract(
        params.campaignAddress,
        params.contracts.campaignAbi,
        params.provider,
    );
    const [listingRaw, statusRaw, fundingSupplyRaw] = await Promise.all([
        readOnlyCampaign.listing(),
        readOnlyCampaign.status(),
        readOnlyCampaign.fundingSupply().catch(() => 0n),
    ]);
    const listing = normalizeListing(listingRaw);
    const status = normalizeStatus(statusRaw);
    const fundingSupply = BigInt(fundingSupplyRaw);

    if (status !== 1 || params.nowUnix < Number(listing.deadline)) {
        return;
    }

    const ownerRaw = await readOnlyCampaign.owner().catch(() => null);
    const ownerAddress =
        typeof ownerRaw === "string" && ownerRaw.length > 0
            ? getAddress(ownerRaw)
            : null;
    if (ownerAddress && ownerAddress !== params.resolver.address) {
        return;
    }

    const resolveTo = ownerAddress ?? params.resolver.address;
    const pairCreateFeeValue =
        fundingSupply >= listing.goal
            ? await resolvePairCreateFeeWeibar({
                  provider: params.provider,
                  contracts: params.contracts,
              })
            : 0n;

    try {
        const data = params.contracts.campaignInterface.encodeFunctionData(
            "resolveCampaign",
            [resolveTo],
        );
        const tx = await params.resolver.signer.sendTransaction({
            to: params.campaignAddress,
            data,
            gasLimit: 1_200_000n,
            value: pairCreateFeeValue,
        });
        await tx.wait();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const warningKey = `${params.campaignAddress}:${message}`;
        if (!warnedCampaignResolveFailures.has(warningKey)) {
            warnedCampaignResolveFailures.add(warningKey);
            console.warn(
                `[launchpad] Failed to auto-resolve campaign ${params.campaignAddress}: ${message}`,
            );
        }
    }
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

function resolveConfiguredPairCreateFeeWeibar(): bigint | null {
    const rawValue = process.env.LAUNCHPAD_PAIR_CREATE_FEE_HBAR;
    if (!rawValue || rawValue.trim().length === 0) {
        return null;
    }
    const value = rawValue.trim();
    try {
        const fee = parseUnits(value, 18);
        if (fee < 0n) {
            throw new Error("negative pair create fee");
        }
        return fee;
    } catch {
        throw new Error(
            "LAUNCHPAD_PAIR_CREATE_FEE_HBAR must be a non-negative decimal HBAR value",
        );
    }
}

async function resolvePairCreateFeeWeibar(params: {
    provider: JsonRpcProvider;
    contracts: ResolvedDeploymentContracts;
}): Promise<bigint> {
    const chainId = (await params.provider.getNetwork()).chainId.toString();
    const cached = pairCreateFeeCache.get(chainId);
    if (cached) return cached;

    const request = (async (): Promise<bigint> => {
        try {
            const launchpad = new Contract(
                params.contracts.launchpadAddress,
                params.contracts.launchpadAbi.length > 0
                    ? params.contracts.launchpadAbi
                    : LAUNCHPAD_READ_ABI,
                params.provider,
            );
            const factoryAddress = getAddress(await launchpad.factory());
            const factory = new Contract(
                factoryAddress,
                PAIR_FEE_FACTORY_ABI,
                params.provider,
            );
            const pairCreateFeeTinycent = BigInt(await factory.pairCreateFee());
            if (pairCreateFeeTinycent <= 0n) return 0n;

            const exchangeRates =
                await fetchMirrorJson<MirrorExchangeRateResponse>(
                    "/api/v1/network/exchangerate",
                );
            const centEquivalent = parseMirrorAmount(
                exchangeRates?.current_rate?.cent_equivalent,
            );
            const hbarEquivalent = parseMirrorAmount(
                exchangeRates?.current_rate?.hbar_equivalent,
            );
            if (
                centEquivalent === null ||
                hbarEquivalent === null ||
                centEquivalent <= 0n ||
                hbarEquivalent <= 0n
            ) {
                throw new Error(
                    "Mirror exchange rate values cent_equivalent/hbar_equivalent are unavailable",
                );
            }

            const tinybarFee =
                (pairCreateFeeTinycent * hbarEquivalent + centEquivalent - 1n) /
                centEquivalent;
            return tinybarsToWeibar(tinybarFee);
        } catch (error) {
            const configured = resolveConfiguredPairCreateFeeWeibar();
            if (configured !== null) {
                return configured;
            }

            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Failed to resolve SaucerSwap pair creation fee dynamically: ${message}. Set LAUNCHPAD_PAIR_CREATE_FEE_HBAR as fallback.`,
            );
        }
    })();

    pairCreateFeeCache.set(chainId, request);
    try {
        return await request;
    } catch (error) {
        pairCreateFeeCache.delete(chainId);
        throw error;
    }
}

function tinybarsToWeibar(amountTinybars: bigint): bigint {
    if (amountTinybars <= 0n) return 0n;
    return amountTinybars * HBAR_TO_WEI_MULTIPLIER;
}

function isWhbarToken(tokenAddress: string, whbarAddress: string): boolean {
    return getAddress(tokenAddress) === getAddress(whbarAddress);
}

async function resolveFundingTokenAddressForHts(params: {
    fundingTokenAddress: string;
    whbarAddress: string;
    whbarInterface: Interface;
    provider: JsonRpcProvider;
}): Promise<string> {
    if (!isWhbarToken(params.fundingTokenAddress, params.whbarAddress)) {
        return getAddress(params.fundingTokenAddress);
    }

    const tokenData = params.whbarInterface.encodeFunctionData("token");
    const tokenResult = await params.provider.call({
        to: params.whbarAddress,
        data: tokenData,
    });
    const [underlyingTokenAddress] = params.whbarInterface.decodeFunctionResult(
        "token",
        tokenResult,
    ) as [string];
    return getAddress(underlyingTokenAddress);
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
    whbarAddress: string,
): Promise<TokenMetadata> {
    const normalizedAddress = getAddress(tokenAddress);
    const isWhbar = isWhbarToken(normalizedAddress, whbarAddress);
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
            : (metadataFromHts?.symbol ?? symbolFallback);
    const symbol = rawSymbol.toUpperCase() === "WHBAR" ? "HBAR" : rawSymbol;
    const decimals =
        decimalsFromContract ?? metadataFromHts?.decimals ?? (isWhbar ? 8 : 18);

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
    const toErrorMessage = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);
    const isHexData = (value: unknown): value is string =>
        typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
    const extractRevertData = (error: unknown, depth = 0): string | null => {
        if (depth > 6 || error == null) return null;

        if (isHexData(error)) {
            return error === "0x" ? null : error;
        }

        if (typeof error === "string") {
            try {
                return extractRevertData(
                    JSON.parse(error) as unknown,
                    depth + 1,
                );
            } catch {
                return null;
            }
        }

        if (typeof error !== "object") return null;
        const record = error as Record<string, unknown>;

        const direct = record.data;
        if (isHexData(direct)) {
            return direct === "0x" ? null : direct;
        }

        for (const key of [
            "error",
            "info",
            "cause",
            "value",
            "result",
            "response",
            "receipt",
        ]) {
            if (record[key] !== undefined) {
                const nested = extractRevertData(record[key], depth + 1);
                if (nested) return nested;
            }
        }

        if (typeof record.body === "string") {
            try {
                const nested = extractRevertData(
                    JSON.parse(record.body) as unknown,
                    depth + 1,
                );
                if (nested) return nested;
            } catch {
                // Ignore invalid JSON payload bodies.
            }
        }

        return null;
    };
    const standardErrorInterface = new Interface([
        "error Error(string)",
        "error Panic(uint256)",
    ]);
    const decodeRevertData = (revertData: string): string => {
        for (const candidate of [
            ...(params.decodeInterfaces ?? []),
            standardErrorInterface,
        ]) {
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

        // Fall through to raw selector output when no interface can decode it.
        return `revertData=${revertData}`;
    };
    const extractReasonText = (error: unknown, depth = 0): string | null => {
        if (depth > 6 || error == null) return null;

        if (typeof error === "string") {
            const raw = error.trim();
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw) as unknown;
                return extractReasonText(parsed, depth + 1);
            } catch {
                const lowered = raw.toLowerCase();
                const directPrefix = "execution reverted: ";
                const reasonStringPrefix = "reverted with reason string ";
                if (lowered.includes(directPrefix)) {
                    return raw
                        .slice(
                            lowered.indexOf(directPrefix) + directPrefix.length,
                        )
                        .trim();
                }
                if (lowered.includes(reasonStringPrefix)) {
                    const extracted = raw.slice(
                        lowered.indexOf(reasonStringPrefix) +
                            reasonStringPrefix.length,
                    );
                    return extracted.replace(/^['"]|['"]$/g, "").trim();
                }
                if (
                    lowered.includes("revert") &&
                    !lowered.includes("contract_revert_executed")
                ) {
                    return raw;
                }
                return null;
            }
        }

        if (typeof error !== "object") return null;
        const record = error as Record<string, unknown>;
        for (const key of [
            "reason",
            "shortMessage",
            "message",
            "error",
            "info",
            "cause",
            "value",
            "result",
            "response",
            "receipt",
            "body",
        ]) {
            if (record[key] === undefined) continue;
            const nested = extractReasonText(record[key], depth + 1);
            if (nested) return nested;
        }
        return null;
    };
    const decodeRevertFromError = (error: unknown): string | null => {
        const revertData = extractRevertData(error);
        if (revertData && revertData !== "0x") {
            return decodeRevertData(revertData);
        }
        return extractReasonText(error);
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
    const readRecordReason = async (): Promise<string | null> => {
        const record = await response
            .getRecord(params.paymasterClient as never)
            .catch(() => null);
        const reason = record?.contractFunctionResult?.errorMessage?.trim();
        return reason && reason.length > 0 ? reason : null;
    };
    const receipt = await response
        .getReceipt(params.paymasterClient as never)
        .catch(async (error) => {
            const message = toErrorMessage(error);
            if (message.includes("CONTRACT_REVERT_EXECUTED")) {
                const decodedFromError = decodeRevertFromError(error);
                const decoded = await simulateForRevertMessage();
                const recordReason = await readRecordReason();
                throw new Error(
                    decodedFromError ??
                        decoded ??
                        recordReason ??
                        "CONTRACT_REVERT_EXECUTED",
                );
            }
            const decodedFromError = decodeRevertFromError(error);
            if (decodedFromError) {
                throw new Error(decodedFromError);
            }
            throw error;
        });
    const transactionId = response.transactionId.toString();
    const receiptStatus = receipt.status.toString();

    if (receiptStatus !== "SUCCESS") {
        const decoded = await simulateForRevertMessage();
        const recordReason = await readRecordReason();
        throw new Error(recordReason ?? decoded ?? receiptStatus);
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
        const [launchpad, campaign, whbar] = await Promise.all([
            readDeploymentContractFile(chainId, "Launchpad"),
            readDeploymentContractFile(chainId, "Campaign"),
            readDeploymentContractFile(chainId, "WHBAR"),
        ]);

        return {
            launchpadAddress: launchpad.address,
            launchpadAbi: launchpad.abi,
            campaignAbi: campaign.abi,
            campaignInterface: new Interface([
                ...campaign.abi,
                "function contributeHbar(address to) payable",
            ]),
            whbarAddress: whbar.address,
            whbarInterface: new Interface(whbar.abi),
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

export async function getLaunchpadCampaigns(params?: {
    userHederaAccountId?: string | null;
}): Promise<LaunchpadCampaignView[]> {
    const provider = resolveEvmProvider();
    const contracts = await resolveDeploymentContracts(provider);
    const resolver = resolveLaunchpadResolver(provider);

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
    const participantAddress = params?.userHederaAccountId
        ? accountIdToSolidityAddress(params.userHederaAccountId)
        : null;
    const workTokenAddress = getAddress(workTokenAddressRaw);
    const tokenCache = new Map<string, Promise<TokenMetadata>>();

    const getCachedTokenMetadata = (tokenAddress: string) => {
        const address = getAddress(tokenAddress);
        const cached = tokenCache.get(address);

        if (cached) return cached;

        const request = getTokenMetadata(
            provider,
            address,
            contracts.whbarAddress,
        );
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
            let status = normalizeStatus(statusRaw);
            const deadlineUnix = Number(listing.deadline);

            if (status === 1 && nowUnix >= deadlineUnix) {
                await tryResolveCampaignOnRead({
                    campaignAddress,
                    contracts,
                    provider,
                    resolver,
                    nowUnix,
                });
                status = normalizeStatus(await campaign.status());
            }
            const { fundingSupplyRaw, campaignSupplyRaw } =
                await readCampaignSuppliesWithFallback({
                    campaign,
                    campaignAddress,
                    listing,
                });
            const statusLabel = getStatusLabel(status);

            const [fundingToken, campaignToken] = await Promise.all([
                getCachedTokenMetadata(listing.fundingToken),
                getCachedTokenMetadata(listing.campaignToken),
            ]);
            const userContributionRaw = participantAddress
                ? BigInt(
                      await launchpad.balanceOf(
                          participantAddress,
                          BigInt(
                              solidityPackedKeccak256(
                                  ["address"],
                                  [campaignAddress],
                              ),
                          ),
                      ),
                  )
                : 0n;
            const hasParticipated = userContributionRaw > 0n;
            const isExpired = nowUnix >= deadlineUnix;
            const inferredCanClaim =
                status === 3 ||
                (status === 1 && isExpired && fundingSupplyRaw >= listing.goal);
            const inferredCanRefund =
                status === 2 ||
                (status === 1 && isExpired && fundingSupplyRaw < listing.goal);

            return {
                campaignAddress,
                status,
                statusLabel,
                deadlineUnix,
                isParticipatable: status === 1 && nowUnix < deadlineUnix,
                hasParticipated,
                userContributionRaw: userContributionRaw.toString(),
                canClaim: hasParticipated && inferredCanClaim,
                canRefund: hasParticipated && inferredCanRefund,
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
    hederaClient: HederaClient;
    whbarAddress: string;
    whbarInterface: Interface;
    tokenAddress: string;
    campaignAddress: string;
    signerAccountId: string;
    participantEvmAddress: string;
    participantContractAddress: string;
}): Promise<{
    whbarBalance: bigint;
    nativeHbarBalance: bigint;
    allowance: bigint;
}> {
    if (isWhbarToken(params.tokenAddress, params.whbarAddress)) {
        const underlyingTokenAddress = await resolveFundingTokenAddressForHts({
            fundingTokenAddress: params.tokenAddress,
            provider: params.provider,
            whbarAddress: params.whbarAddress,
            whbarInterface: params.whbarInterface,
        });
        const whbarTokenIdRaw = await resolveTokenIdFromAddress(
            getAddress(underlyingTokenAddress),
        );
        if (!whbarTokenIdRaw) {
            throw new Error(
                `Unable to resolve WHBAR underlying token id for ${underlyingTokenAddress}.`,
            );
        }
        const token = new Contract(
            underlyingTokenAddress,
            ERC20_ABI,
            params.provider,
        );

        const [
            snapshot,
            nativeBalance,
            allowanceForEvmAddressOnChain,
            allowanceForContractAddressOnChain,
        ] = await Promise.all([
            getHtsTokenBalanceSnapshot({
                client: params.hederaClient,
                accountId: params.signerAccountId,
                tokenId: TokenId.fromString(whbarTokenIdRaw),
            }),
            getNativeHbarBalanceTinybars(
                params.hederaClient,
                params.signerAccountId,
            ),
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
        ]);

        return {
            whbarBalance: snapshot.balance,
            nativeHbarBalance: nativeBalance,
            allowance: pickFirstNonNull(
                allowanceForEvmAddressOnChain,
                allowanceForContractAddressOnChain,
            ),
        };
    }

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
        readNativeHbarBalance(
            params.provider,
            params.participantContractAddress,
        ),
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
    const fundingToken = new Contract(
        listing.fundingToken,
        ERC20_ABI,
        provider,
    );

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
        (isWhbarToken(listing.fundingToken, contracts.whbarAddress)
            ? HBAR_DECIMALS
            : 18);

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
                contributionContext.contracts.whbarAddress,
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
    paymasterClient: ReturnType<typeof createHederaClient>;
    contracts: ResolvedDeploymentContracts;
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
                hederaClient: ctx.paymasterClient,
                whbarAddress: ctx.contracts.whbarAddress,
                whbarInterface: ctx.contracts.whbarInterface,
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

async function getHtsTokenBalanceSnapshot(params: {
    client: HederaClient;
    accountId: string;
    tokenId: TokenId;
}): Promise<{ associated: boolean; balance: bigint }> {
    const balance = await new AccountBalanceQuery()
        .setAccountId(params.accountId)
        .execute(params.client);

    const tokenIdStr = params.tokenId.toString();

    let associated = false;
    let balanceTiny = 0n;

    for (const [id, amount] of balance.tokens ?? []) {
        if (id.toString() === tokenIdStr) {
            associated = true;
            balanceTiny = BigInt(amount.toString());
            break;
        }
    }

    return {
        associated,
        balance: balanceTiny,
    };
}

async function getNativeHbarBalanceTinybars(
    client: HederaClient,
    accountId: string,
): Promise<bigint> {
    const balance = await new AccountBalanceQuery()
        .setAccountId(accountId)
        .execute(client);
    return BigInt(balance.hbars.toTinybars().toString());
}

async function ensureTokenAssociationWithKms(params: {
    hederaClient: HederaClient;
    hederaAccountId: string;
    tokenId: TokenId;
    kms: ReturnType<typeof createKmsClientFromEnv>;
    kmsKeyId: string;
}): Promise<string | null> {
    const snapshot = await getHtsTokenBalanceSnapshot({
        client: params.hederaClient,
        accountId: params.hederaAccountId,
        tokenId: params.tokenId,
    });

    if (snapshot.associated) {
        return null;
    }

    const signer = await createKmsHederaSigner({
        kms: params.kms,
        keyId: params.kmsKeyId,
    });

    let tx = new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(params.hederaAccountId))
        .setTokenIds([params.tokenId]);
    tx = await tx.freezeWith(params.hederaClient);

    await addKmsSignatureToFrozenTransaction(tx, signer);
    const { response, receipt } = await executeSignedTransaction(
        params.hederaClient,
        tx,
    );
    const status = receipt.status.toString();
    if (
        status !== "SUCCESS" &&
        status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT"
    ) {
        throw new Error(
            `Funding token association failed with status: ${status}`,
        );
    }

    return response.transactionId.toString();
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
                    associateFundingToken: async () => {
                        const tokenAddressToAssociate =
                            await resolveFundingTokenAddressForHts({
                                fundingTokenAddress: ctx.listing.fundingToken,
                                provider: ctx.provider,
                                whbarAddress: ctx.contracts.whbarAddress,
                                whbarInterface: ctx.contracts.whbarInterface,
                            });

                        const tokenIdRaw = await resolveTokenIdFromAddress(
                            tokenAddressToAssociate,
                        );
                        if (!tokenIdRaw) {
                            throw new Error(
                                `Unable to resolve funding token ID for association (token address: ${tokenAddressToAssociate}).`,
                            );
                        }

                        const transactionId =
                            await ensureTokenAssociationWithKms({
                                hederaClient: ctx.paymasterClient,
                                hederaAccountId:
                                    ctx.signerContext.hederaAccountId,
                                tokenId: TokenId.fromString(tokenIdRaw),
                                kms: ctx.kms,
                                kmsKeyId: ctx.signerContext.kmsKeyId,
                            });

                        if (!transactionId) {
                            return null;
                        }
                        return {
                            type: "associate",
                            transactionId,
                            mirrorLink: mirrorLinkForTransaction(
                                ctx.hederaNetwork,
                                transactionId,
                            ),
                        };
                    },
                    wrapHbar: async (amount) => {
                        const wrapData =
                            ctx.contracts.whbarInterface.encodeFunctionData(
                                "deposit()",
                            );
                        const wrapResult = await executeSponsoredTransaction({
                            paymasterClient: ctx.paymasterClient,
                            hederaNetwork: ctx.hederaNetwork,
                            kmsKeyId: ctx.signerContext.kmsKeyId,
                            kms: ctx.kms,
                            provider: ctx.provider,
                            nonce,
                            from: ctx.participantEvmAddress,
                            to: ctx.contracts.whbarAddress,
                            data: wrapData,
                            gasLimit: 180_000n,
                            // WHBAR amount math uses tinybars (8dp), but EVM tx value is wei (18dp).
                            value: tinybarsToWeibar(amount),
                        });
                        nonce += 1;
                        return {
                            type: "wrap_hbar",
                            transactionId: wrapResult.transactionId,
                            mirrorLink: wrapResult.mirrorLink,
                        };
                    },
                    approveFundingToken: async (amount) => {
                        const tokenAddressToApprove =
                            await resolveFundingTokenAddressForHts({
                                fundingTokenAddress: ctx.listing.fundingToken,
                                provider: ctx.provider,
                                whbarAddress: ctx.contracts.whbarAddress,
                                whbarInterface: ctx.contracts.whbarInterface,
                            });
                        const approveData = erc20Interface.encodeFunctionData(
                            "approve",
                            [ctx.config.campaignAddress, amount],
                        );
                        const approveResult = await executeSponsoredTransaction(
                            {
                                paymasterClient: ctx.paymasterClient,
                                hederaNetwork: ctx.hederaNetwork,
                                kmsKeyId: ctx.signerContext.kmsKeyId,
                                kms: ctx.kms,
                                provider: ctx.provider,
                                nonce,
                                from: ctx.participantEvmAddress,
                                to: tokenAddressToApprove,
                                data: approveData,
                                gasLimit: 150_000n,
                                decodeInterfaces: [erc20Interface],
                            },
                        );
                        nonce += 1;
                        return {
                            type: "approve",
                            transactionId: approveResult.transactionId,
                            mirrorLink: approveResult.mirrorLink,
                        };
                    },
                    contribute: async (amount, recipient) => {
                        const isNativeContribution =
                            ctx.config.isWhbarFundingToken;
                        const contributeData =
                            ctx.contracts.campaignInterface.encodeFunctionData(
                                isNativeContribution
                                    ? "contributeHbar"
                                    : "contribute",
                                isNativeContribution
                                    ? [recipient]
                                    : [amount, recipient],
                            );
                        const contributeResult =
                            await executeSponsoredTransaction({
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
                                value: isNativeContribution
                                    ? tinybarsToWeibar(amount)
                                    : undefined,
                                decodeInterfaces: [
                                    ctx.contracts.campaignInterface,
                                ],
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

export async function settleCampaignParticipation(params: {
    userId: string;
    campaignAddress: string;
}): Promise<SettleCampaignParticipationResult> {
    const provider = resolveEvmProvider();
    const contracts = await resolveDeploymentContracts(provider);
    const resolver = resolveLaunchpadResolver(provider);
    const normalizedCampaignAddress = getAddress(params.campaignAddress);

    const launchpad = new Contract(
        contracts.launchpadAddress,
        contracts.launchpadAbi.length > 0
            ? contracts.launchpadAbi
            : LAUNCHPAD_READ_ABI,
        provider,
    );
    const campaign = new Contract(
        normalizedCampaignAddress,
        contracts.campaignAbi,
        provider,
    );

    const [listingRaw, initialStatusRaw] = await Promise.all([
        campaign.listing(),
        campaign.status(),
    ]);
    const listing = normalizeListing(listingRaw);
    const nowUnix = Math.floor(Date.now() / 1000);

    let status = normalizeStatus(initialStatusRaw);
    if (status === 1 && nowUnix >= Number(listing.deadline)) {
        await tryResolveCampaignOnRead({
            campaignAddress: normalizedCampaignAddress,
            contracts,
            provider,
            resolver,
            nowUnix,
        });
        status = normalizeStatus(await campaign.status());
    }

    const { fundingSupplyRaw } = await readCampaignSuppliesWithFallback({
        campaign,
        campaignAddress: normalizedCampaignAddress,
        listing,
    });

    const signerContext = await getManagedWalletSignerContext(params.userId);
    const participantAddress = accountIdToSolidityAddress(
        signerContext.hederaAccountId,
    );
    const contributionRaw = BigInt(
        await launchpad.balanceOf(
            participantAddress,
            BigInt(
                solidityPackedKeccak256(
                    ["address"],
                    [normalizedCampaignAddress],
                ),
            ),
        ),
    );
    if (contributionRaw <= 0n) {
        throw new Error("No contribution balance available for this campaign.");
    }

    const kms = createKmsClientFromEnv();
    const hederaNetwork = resolveSponsoredHederaNetwork();
    const { operatorId, operatorKey } = resolvePaymasterCredentials();
    const paymasterClient = createHederaClient({
        network: hederaNetwork,
        operatorId,
        operatorKey,
    });

    try {
        const signer = await createKmsEvmSigner({
            kms,
            keyId: signerContext.kmsKeyId,
            provider,
        });
        const from = await signer.getAddress();
        let nonce = await provider.getTransactionCount(from, "pending");

        const expired = nowUnix >= Number(listing.deadline);
        let action: "redeem" | "refund";
        if (status === 3) {
            action = "redeem";
        } else if (
            status === 2 ||
            (status === 1 && expired && fundingSupplyRaw < listing.goal)
        ) {
            action = "refund";
        } else if (
            status === 1 &&
            expired &&
            fundingSupplyRaw >= listing.goal
        ) {
            const ownerRaw = await campaign.owner().catch(() => null);
            const ownerAddress =
                typeof ownerRaw === "string" && ownerRaw.length > 0
                    ? getAddress(ownerRaw)
                    : null;
            const userAddress = getAddress(from);
            let resolvedByOwner = false;
            let resolverResolveError: string | null = null;
            const pairCreateFeeValue = await resolvePairCreateFeeWeibar({
                provider,
                contracts,
            });

            // Prefer resolver/operator ownership path so campaign can resolve regardless of participant wallet.
            if (resolver) {
                const resolverAddress = getAddress(resolver.address);
                if (!ownerAddress || ownerAddress === resolverAddress) {
                    try {
                        const resolveTo = ownerAddress ?? resolverAddress;
                        const resolveData =
                            contracts.campaignInterface.encodeFunctionData(
                                "resolveCampaign",
                                [resolveTo],
                            );
                        const standardErrorInterface = new Interface([
                            "error Error(string)",
                            "error Panic(uint256)",
                        ]);
                        const decodeResolverError = (
                            error: unknown,
                        ): string | null => {
                            const extractHex = (
                                value: unknown,
                                depth = 0,
                            ): string | null => {
                                if (depth > 5 || value == null) return null;
                                if (
                                    typeof value === "string" &&
                                    /^0x[0-9a-fA-F]+$/.test(value) &&
                                    value !== "0x"
                                ) {
                                    return value;
                                }
                                if (typeof value !== "object") return null;
                                const rec = value as Record<string, unknown>;
                                for (const key of [
                                    "data",
                                    "error",
                                    "info",
                                    "cause",
                                    "value",
                                    "result",
                                    "response",
                                    "receipt",
                                ]) {
                                    const nested = extractHex(
                                        rec[key],
                                        depth + 1,
                                    );
                                    if (nested) return nested;
                                }
                                return null;
                            };
                            const revertData = extractHex(error);
                            if (revertData) {
                                for (const iface of [
                                    contracts.campaignInterface,
                                    standardErrorInterface,
                                ]) {
                                    try {
                                        const parsed =
                                            iface.parseError(revertData);
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
                                        // try next interface
                                    }
                                }
                                return `revertData=${revertData}`;
                            }
                            return error instanceof Error
                                ? error.message
                                : String(error);
                        };
                        const simulateResolverRevert = async (): Promise<
                            string | null
                        > => {
                            try {
                                await provider.call({
                                    from: resolverAddress,
                                    to: normalizedCampaignAddress,
                                    data: resolveData,
                                    value: pairCreateFeeValue,
                                });
                                return null;
                            } catch (error) {
                                return decodeResolverError(error);
                            }
                        };
                        const network = await provider.getNetwork();
                        const estimatedGas = await provider
                            .estimateGas({
                                from: resolverAddress,
                                to: normalizedCampaignAddress,
                                data: resolveData,
                                value: pairCreateFeeValue,
                            })
                            .catch(() => 1_200_000n);
                        const paddedEstimate = (estimatedGas * 120n) / 100n;
                        const gasLimit =
                            paddedEstimate > 1_200_000n
                                ? paddedEstimate
                                : 1_200_000n;
                        const resolverNonce = await provider.getTransactionCount(
                            resolverAddress,
                            "pending",
                        );
                        const signedResolveTx =
                            await resolver.signer.signTransaction({
                                chainId: BigInt(network.chainId),
                                from: resolverAddress,
                                to: normalizedCampaignAddress,
                                data: resolveData,
                                value: pairCreateFeeValue,
                                nonce: resolverNonce,
                                gasLimit,
                                gasPrice: 0n,
                            });

                        const tx = new EthereumTransaction()
                            .setEthereumData(getBytes(signedResolveTx))
                            .setMaxGasAllowanceHbar(
                                resolveMaxGasAllowanceHbar(),
                            );
                        const response = await tx.execute(paymasterClient as never);
                        const readRecordReason = async (): Promise<string | null> => {
                            const record = await response
                                .getRecord(paymasterClient as never)
                                .catch(() => null);
                            const reason =
                                record?.contractFunctionResult?.errorMessage?.trim();
                            return reason && reason.length > 0 ? reason : null;
                        };
                        const receipt = await response
                            .getReceipt(paymasterClient as never)
                            .catch(async (error) => {
                                const decoded = decodeResolverError(error);
                                const simulated = await simulateResolverRevert();
                                const recordReason = await readRecordReason();
                                throw new Error(
                                    decoded ??
                                        simulated ??
                                        recordReason ??
                                        "Resolver receipt failed",
                                );
                            });
                        const receiptStatus = receipt.status.toString();
                        if (receiptStatus !== "SUCCESS") {
                            const simulated = await simulateResolverRevert();
                            const recordReason = await readRecordReason();
                            throw new Error(
                                recordReason ?? simulated ?? receiptStatus,
                            );
                        }
                        resolvedByOwner = true;
                    } catch (error) {
                        resolverResolveError =
                            error instanceof Error
                                ? error.message
                                : String(error);
                    }
                }
            }

            if (
                !resolvedByOwner &&
                ownerAddress &&
                ownerAddress === userAddress
            ) {
                const resolveData =
                    contracts.campaignInterface.encodeFunctionData(
                        "resolveCampaign",
                        [userAddress],
                    );
                await executeSponsoredTransaction({
                    paymasterClient,
                    hederaNetwork,
                    kmsKeyId: signerContext.kmsKeyId,
                    kms,
                    provider,
                    nonce,
                    from: userAddress,
                    to: normalizedCampaignAddress,
                    data: resolveData,
                    gasLimit: 1_200_000n,
                    value: pairCreateFeeValue,
                    decodeInterfaces: [contracts.campaignInterface],
                });
                nonce += 1;
                resolvedByOwner = true;
            }

            status = normalizeStatus(await campaign.status());
            if (status === 3) {
                action = "redeem";
            } else if (status === 2) {
                action = "refund";
            } else {
                const ownerHint = ownerAddress
                    ? ` Campaign owner is ${ownerAddress}.`
                    : "";
                const resolverHint = resolver
                    ? ` Configured resolver is ${getAddress(resolver.address)}.`
                    : " No resolver private key is configured.";
                const resolverErrorHint = resolverResolveError
                    ? ` Resolver error: ${resolverResolveError}.`
                    : "";
                const resolutionHint = resolvedByOwner
                    ? " Resolution transaction ran, but campaign status is still Funding."
                    : " Automatic resolution was not executed.";
                throw new Error(
                    `Campaign reached goal but is not resolved yet.${ownerHint}${resolverHint}${resolverErrorHint}${resolutionHint}`,
                );
            }
        } else {
            throw new Error(
                "Campaign must be expired and resolved (or failed by goal check) before redeem/refund.",
            );
        }
        const fnName =
            action === "redeem" ? "redeemContribution" : "refundContribution";
        const data = contracts.campaignInterface.encodeFunctionData(fnName, [
            contributionRaw,
            participantAddress,
        ]);

        const tx = await executeSponsoredTransaction({
            paymasterClient,
            hederaNetwork,
            kmsKeyId: signerContext.kmsKeyId,
            kms,
            provider,
            nonce,
            from,
            to: normalizedCampaignAddress,
            data,
            gasLimit: 650_000n,
            decodeInterfaces: [contracts.campaignInterface],
        });

        return {
            campaignAddress: normalizedCampaignAddress,
            action,
            amountRaw: contributionRaw.toString(),
            transaction: {
                type: action,
                transactionId: tx.transactionId,
                mirrorLink: tx.mirrorLink,
            },
        };
    } finally {
        kms.destroy();
        paymasterClient.close();
    }
}
