import { AccountId, Client, PrivateKey, PublicKey, TokenAssociateTransaction, TokenId, TransactionId } from "@hashgraph/sdk";
import { createKmsClientFromEnv, createKmsHederaSigner, type HederaNetwork } from "@workit-poa/hedera-kms-wallet";
import { Contract, Interface, getAddress, id, isAddress, parseUnits, solidityPacked, zeroPadValue, type ContractRunner, type JsonRpcProvider } from "ethers";

const BPS_DENOMINATOR = 10_000n;
const HBAR_DECIMALS = 8;
const MAX_UINT24 = 16_777_215;

const USDC_TESTNET_ID = "0.0.5449";
const DEFAULT_USDC_ADDRESS = hederaEntityIdToEvmAddress(USDC_TESTNET_ID, "token");
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_USDC_SYMBOL = "USDC";

const SAUCER_V2_ROUTER_TESTNET_ID = "0.0.1414040";
const SAUCER_V2_QUOTER_TESTNET_ID = "0.0.1390002";
const WHBAR_TESTNET_ID = "0.0.15057";

const DEFAULT_SAUCER_V2_ROUTER_ADDRESS = hederaEntityIdToEvmAddress(SAUCER_V2_ROUTER_TESTNET_ID, "account");
const DEFAULT_SAUCER_V2_QUOTER_ADDRESS = hederaEntityIdToEvmAddress(SAUCER_V2_QUOTER_TESTNET_ID, "account");
const DEFAULT_WHBAR_ADDRESS = hederaEntityIdToEvmAddress(WHBAR_TESTNET_ID, "token");

// TODO: Verify this fee tier against the deployed WHBAR/USDC pool on Hedera testnet.
const DEFAULT_SAUCER_V2_WHBAR_USDC_POOL_FEE = 3000;
const KNOWN_SAUCER_V2_FEE_TIERS = [500, 1500, 3000, 10000] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const POOL_CREATED_TOPIC = id("PoolCreated(address,address,uint24,int24,address)");
const POOL_CREATED_IFACE = new Interface([
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)"
]);

const SAUCER_V2_ROUTER_ABI = [
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)"
];

const SAUCER_V2_ROUTE_DISCOVERY_ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WHBAR() view returns (address)"
];

const SAUCER_V2_FACTORY_ABI = [
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"
];

const SAUCER_V2_QUOTER_ABI = [
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)"
];

export interface SaucerV2FaucetConfig {
  routerAddress: string;
  quoterAddress: string;
  wrappedNativeAddress: string | null;
  usdcAddress: string;
  usdcDecimals: number;
  usdcSymbol: string;
  poolFee: number | null;
  slippageBps: bigint;
  deadlineSeconds: number;
  hederaNetwork: HederaNetwork;
  associationOperatorId: string;
  associationOperatorKey: string;
}

export interface SaucerV2SwapParams {
  provider: JsonRpcProvider;
  operatorRunner: ContractRunner;
  recipientAddress: string;
  recipientAccountId: string;
  recipientKmsKeyId: string;
  targetUsdcAmount: string;
  config: SaucerV2FaucetConfig;
}

export interface SaucerV2SwapResult {
  transactionHash: string;
  amountIn: bigint;
  quotedAmountOut: bigint;
  amountOutMinimum: bigint;
  tokenSymbol: string;
}

export interface ExactInputParams {
  path: string;
  recipient: string;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
}

interface RouteHop {
  tokenIn: string;
  fee: number;
  tokenOut: string;
}

interface ResolvedSaucerRoute {
  hops: RouteHop[];
}

interface SaucerV2Contracts {
  quoteExactInput: (path: string, amountIn: bigint) => Promise<bigint>;
  exactInput: (params: ExactInputParams, value: bigint) => Promise<{ transactionHash: string; status: number | null }>;
}

interface EnsureRecipientAssociationParams {
  recipientAccountId: string;
  recipientKmsKeyId: string;
  tokenAddress: string;
  network: HederaNetwork;
  operatorId: string;
  operatorKey: string;
}

interface ResolveAmountInForTargetOutParams {
  path: string;
  targetAmountOut: bigint;
  slippageBps: bigint;
  quoteExactInput: (path: string, amountIn: bigint) => Promise<bigint>;
}

interface SaucerV2SwapDeps {
  now?: () => number;
  ensureRecipientAssociation?: (params: EnsureRecipientAssociationParams) => Promise<void>;
  createContracts?: (config: SaucerV2FaucetConfig, operatorRunner: ContractRunner) => SaucerV2Contracts;
  resolveRoute?: (config: SaucerV2FaucetConfig, provider: JsonRpcProvider) => Promise<ResolvedSaucerRoute>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasTokenAssociationFailure(message: string): boolean {
  const normalized = message.toUpperCase();
  return normalized.includes("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT") || normalized.includes("TOKEN_NOT_ASSOCIATED");
}

function parsePositiveInteger(value: string, name: string, max?: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && numeric > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return numeric;
}

function parseAddress(value: string, name: string): string {
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return getAddress(value);
}

function resolveHederaNetworkForAssociation(): HederaNetwork {
  const network = (process.env.HEDERA_NETWORK || "testnet").trim().toLowerCase();
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("HEDERA_NETWORK must be either testnet or mainnet for faucet token association");
  }
  return network;
}

function resolveAssociationOperatorCredentials(): { operatorId: string; operatorKey: string } {
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
      "Missing Hedera operator credentials for faucet token association. Set PAYMASTER_OPERATOR_ID/PAYMASTER_OPERATOR_KEY (or OPERATOR_ID/OPERATOR_KEY)."
    );
  }

  return { operatorId, operatorKey };
}

function parseOperatorPrivateKey(operatorKey: string): PrivateKey {
  const value = operatorKey.trim();
  const hexValue = value.startsWith("0x") ? value.slice(2) : value;
  const isHex = /^[0-9a-fA-F]+$/.test(hexValue);

  if (isHex && PrivateKey.isDerKey(hexValue)) {
    return PrivateKey.fromStringDer(hexValue);
  }

  const explicitType = process.env.OPERATOR_KEY_TYPE?.toLowerCase();
  if (explicitType === "ecdsa" || explicitType === "secp256k1") {
    return PrivateKey.fromStringECDSA(hexValue);
  }
  if (explicitType === "ed25519") {
    return PrivateKey.fromStringED25519(hexValue);
  }
  if (explicitType === "der") {
    return PrivateKey.fromStringDer(hexValue);
  }

  if (isHex) {
    try {
      return PrivateKey.fromStringECDSA(hexValue);
    } catch {
      return PrivateKey.fromStringED25519(hexValue);
    }
  }

  return PrivateKey.fromString(value);
}

function resolveSlippageBps(): bigint {
  const raw = process.env.FAUCET_SLIPPAGE_BPS?.trim() || "500";
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 5000) {
    throw new Error("FAUCET_SLIPPAGE_BPS must be an integer between 0 and 5000");
  }
  return BigInt(numeric);
}

function resolveDeadlineSeconds(): number {
  const raw = process.env.FAUCET_SWAP_DEADLINE_SECONDS?.trim() || "600";
  return parsePositiveInteger(raw, "FAUCET_SWAP_DEADLINE_SECONDS");
}

function resolvePoolFee(): number | null {
  const raw = process.env.FAUCET_SAUCER_V2_POOL_FEE?.trim();
  if (!raw) {
    return null;
  }
  return parsePositiveInteger(raw, "FAUCET_SAUCER_V2_POOL_FEE", MAX_UINT24);
}

function resolveUsdcDecimals(): number {
  const raw = process.env.FAUCET_USDC_DECIMALS?.trim() || `${DEFAULT_USDC_DECIMALS}`;
  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("FAUCET_USDC_DECIMALS must be an integer between 0 and 18");
  }
  return decimals;
}

function hederaEntityIdToEvmAddress(id: string, entity: "account" | "token"): string {
  try {
    const solidityAddress = entity === "account" ? AccountId.fromString(id).toSolidityAddress() : TokenId.fromString(id).toSolidityAddress();
    return getAddress(`0x${solidityAddress}`);
  } catch {
    throw new Error(`Invalid Hedera ${entity} id: ${id}`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Division denominator must be greater than zero");
  }
  return (numerator + denominator - 1n) / denominator;
}

function normalizeQuotedAmountOut(rawQuote: unknown): bigint {
  if (typeof rawQuote === "bigint") {
    return rawQuote;
  }

  if (Array.isArray(rawQuote)) {
    const first = rawQuote[0];
    if (typeof first === "bigint") {
      return first;
    }
  }

  const quoteWithAmountOut = rawQuote as { amountOut?: unknown } | null;
  if (quoteWithAmountOut && typeof quoteWithAmountOut.amountOut === "bigint") {
    return quoteWithAmountOut.amountOut;
  }

  throw new Error("Quoter returned an unexpected response payload");
}

function createSaucerV2Contracts(config: SaucerV2FaucetConfig, operatorRunner: ContractRunner): SaucerV2Contracts {
  const router = new Contract(config.routerAddress, SAUCER_V2_ROUTER_ABI, operatorRunner);
  const quoter = new Contract(config.quoterAddress, SAUCER_V2_QUOTER_ABI, operatorRunner);

  return {
    quoteExactInput: async (path: string, amountIn: bigint) => {
      const raw = await quoter.quoteExactInput.staticCall(path, amountIn);
      return normalizeQuotedAmountOut(raw);
    },
    exactInput: async (params: ExactInputParams, value: bigint) => {
      const tx = await router.exactInput(params, { value });
      const receipt = await tx.wait();
      return {
        transactionHash: String(tx.hash),
        status: receipt?.status ?? null
      };
    }
  };
}

async function ensureRecipientTokenAssociation(params: EnsureRecipientAssociationParams): Promise<void> {
  const accountId = AccountId.fromString(params.recipientAccountId);
  const tokenId = TokenId.fromSolidityAddress(params.tokenAddress);
  const payerAccountId = AccountId.fromString(params.operatorId);

  const kms = createKmsClientFromEnv();
  const client = params.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(payerAccountId, parseOperatorPrivateKey(params.operatorKey));

  try {
    const signer = await createKmsHederaSigner({
      kms,
      keyId: params.recipientKmsKeyId
    });
    const recipientPublicKey = PublicKey.fromBytes(signer.hederaPublicKey.toBytesRaw());

    let tx = new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .setTransactionId(TransactionId.generate(payerAccountId));
    tx = await tx.freezeWith(client);

    await tx.signWith(recipientPublicKey, async bodyBytes => {
      const signature = await signer.sign(bodyBytes);
      if (signature.length !== 64) {
        throw new Error("Signer must return a 64-byte (r||s) secp256k1 signature");
      }
      return signature;
    });
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const status = receipt.status.toString();

    if (status !== "SUCCESS" && status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
      throw new Error(`Association failed with status ${status}`);
    }
  } catch (error) {
    const message = toErrorMessage(error);
    if (message.toUpperCase().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
      return;
    }

    throw new Error(`Unable to associate recipient account with USDC: ${message}`);
  } finally {
    kms.destroy();
    client.close();
  }
}

async function resolveAmountInForTargetOut(params: ResolveAmountInForTargetOutParams): Promise<{ amountIn: bigint; quotedAmountOut: bigint }> {
  if (params.targetAmountOut <= 0n) {
    throw new Error("Target output amount must be greater than zero");
  }

  const slippageMultiplier = BPS_DENOMINATOR - params.slippageBps;
  if (slippageMultiplier <= 0n) {
    throw new Error("Slippage basis points must be less than 10000");
  }

  // Ensure quoted output has enough headroom so slippage-adjusted min output stays near the target.
  const targetQuotedOut = ceilDiv(params.targetAmountOut * BPS_DENOMINATOR, slippageMultiplier);
  const oneHbarInTinybars = 10n ** BigInt(HBAR_DECIMALS);
  const oneHbarQuote = await params.quoteExactInput(params.path, oneHbarInTinybars);

  if (oneHbarQuote <= 0n) {
    throw new Error("SaucerSwap quoter returned zero output for 1 HBAR; verify pool fee/path configuration.");
  }

  let amountIn = ceilDiv(targetQuotedOut * oneHbarInTinybars, oneHbarQuote);
  if (amountIn <= 0n) {
    amountIn = 1n;
  }

  let quotedAmountOut = 0n;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    quotedAmountOut = await params.quoteExactInput(params.path, amountIn);
    if (quotedAmountOut >= targetQuotedOut) {
      return { amountIn, quotedAmountOut };
    }

    if (quotedAmountOut <= 0n) {
      throw new Error("SaucerSwap quoter returned zero output while estimating input amount.");
    }

    const topUp = ceilDiv((targetQuotedOut - quotedAmountOut) * amountIn, quotedAmountOut);
    amountIn = amountIn + (topUp > 0n ? topUp : 1n);
  }

  throw new Error("Unable to estimate enough HBAR input for target USDC output. Verify pool fee and liquidity.");
}

function orderedCandidateFees(preferredFee: number | null): number[] {
  return preferredFee !== null ? [preferredFee, ...KNOWN_SAUCER_V2_FEE_TIERS.filter(fee => fee !== preferredFee)] : [...KNOWN_SAUCER_V2_FEE_TIERS];
}

function ensureValidPath(tokens: string[], fees: number[]): void {
  if (tokens.length < 2) {
    throw new Error("Swap path must include at least tokenIn and tokenOut");
  }
  if (fees.length !== tokens.length - 1) {
    throw new Error("Swap path fees length must be exactly tokens length - 1");
  }
}

function parsePoolCreatedLogTokenPair(log: { topics: readonly string[]; data: string }): { token0: string; token1: string; fee: number } | null {
  try {
    const parsed = POOL_CREATED_IFACE.parseLog({
      topics: log.topics,
      data: log.data
    });
    if (!parsed) {
      return null;
    }
    const token0 = parseAddress(String(parsed.args.token0), "pool token0");
    const token1 = parseAddress(String(parsed.args.token1), "pool token1");
    const fee = Number(parsed.args.fee);

    if (!Number.isInteger(fee) || fee <= 0 || fee > MAX_UINT24) {
      return null;
    }

    return { token0, token1, fee };
  } catch {
    return null;
  }
}

async function loadFactoryPoolLogsForIndexedToken(
  provider: JsonRpcProvider,
  factoryAddress: string,
  tokenAddress: string,
  index: 1 | 2
): Promise<Array<{ topics: readonly string[]; data: string }>> {
  const tokenTopic = zeroPadValue(tokenAddress, 32);
  const topics = index === 1 ? [POOL_CREATED_TOPIC, tokenTopic, null] : [POOL_CREATED_TOPIC, null, tokenTopic];

  try {
    return await provider.getLogs({
      address: factoryAddress,
      fromBlock: 0,
      toBlock: "latest",
      topics
    });
  } catch {
    const latestBlock = await provider.getBlockNumber();
    const chunkSize = 100_000;
    const logs: Array<{ topics: readonly string[]; data: string }> = [];

    for (let fromBlock = 0; fromBlock <= latestBlock; fromBlock += chunkSize + 1) {
      const toBlock = Math.min(fromBlock + chunkSize, latestBlock);
      const chunk = await provider.getLogs({
        address: factoryAddress,
        fromBlock,
        toBlock,
        topics
      });
      logs.push(...chunk);
    }

    return logs;
  }
}

async function findTwoHopRouteFromPoolEvents(params: {
  provider: JsonRpcProvider;
  factoryAddress: string;
  tokenIn: string;
  tokenOut: string;
  preferredFee: number | null;
}): Promise<[RouteHop, RouteHop] | null> {
  const { provider, factoryAddress, tokenIn, tokenOut, preferredFee } = params;
  const tokenInLogs = await loadFactoryPoolLogsForIndexedToken(provider, factoryAddress, tokenIn, 1);
  const tokenInLogsAlt = await loadFactoryPoolLogsForIndexedToken(provider, factoryAddress, tokenIn, 2);
  const tokenOutLogs = await loadFactoryPoolLogsForIndexedToken(provider, factoryAddress, tokenOut, 1);
  const tokenOutLogsAlt = await loadFactoryPoolLogsForIndexedToken(provider, factoryAddress, tokenOut, 2);

  const tokenInNeighborFees = new Map<string, Set<number>>();
  const tokenOutNeighborFees = new Map<string, Set<number>>();
  const pushNeighborFee = (map: Map<string, Set<number>>, tokenA: string, tokenB: string, fee: number, baseToken: string): void => {
    const neighbor = tokenA === baseToken ? tokenB : tokenA;
    if (!map.has(neighbor)) {
      map.set(neighbor, new Set<number>());
    }
    map.get(neighbor)?.add(fee);
  };

  for (const log of [...tokenInLogs, ...tokenInLogsAlt]) {
    const parsed = parsePoolCreatedLogTokenPair(log);
    if (!parsed) continue;
    if (parsed.token0 !== tokenIn && parsed.token1 !== tokenIn) continue;
    pushNeighborFee(tokenInNeighborFees, parsed.token0, parsed.token1, parsed.fee, tokenIn);
  }

  for (const log of [...tokenOutLogs, ...tokenOutLogsAlt]) {
    const parsed = parsePoolCreatedLogTokenPair(log);
    if (!parsed) continue;
    if (parsed.token0 !== tokenOut && parsed.token1 !== tokenOut) continue;
    pushNeighborFee(tokenOutNeighborFees, parsed.token0, parsed.token1, parsed.fee, tokenOut);
  }

  const intermediateCandidates = [...tokenInNeighborFees.keys()].filter(token => token !== tokenIn && token !== tokenOut && tokenOutNeighborFees.has(token));
  intermediateCandidates.sort();

  for (const intermediateToken of intermediateCandidates) {
    const tokenInFees = [...(tokenInNeighborFees.get(intermediateToken) ?? [])];
    const tokenOutFees = [...(tokenOutNeighborFees.get(intermediateToken) ?? [])];
    const orderedTokenInFees = orderedCandidateFees(preferredFee).filter(fee => tokenInFees.includes(fee));
    const orderedTokenOutFees = orderedCandidateFees(preferredFee).filter(fee => tokenOutFees.includes(fee));

    for (const feeIn of orderedTokenInFees) {
      for (const feeOut of orderedTokenOutFees) {
        return [
          {
            tokenIn,
            fee: feeIn,
            tokenOut: intermediateToken
          },
          {
            tokenIn: intermediateToken,
            fee: feeOut,
            tokenOut
          }
        ];
      }
    }
  }

  return null;
}

async function resolveRoute(config: SaucerV2FaucetConfig, provider: JsonRpcProvider): Promise<ResolvedSaucerRoute> {
  const router = new Contract(config.routerAddress, SAUCER_V2_ROUTE_DISCOVERY_ROUTER_ABI, provider);
  const factoryAddress = parseAddress(await router.factory.staticCall(), "router.factory()");

  let wrappedNativeAddress = config.wrappedNativeAddress;
  if (!wrappedNativeAddress) {
    try {
      wrappedNativeAddress = parseAddress(await router.WHBAR.staticCall(), "router.WHBAR()");
    } catch (error) {
      const message = toErrorMessage(error);
      wrappedNativeAddress = DEFAULT_WHBAR_ADDRESS;
      if (!wrappedNativeAddress) {
        throw new Error(`Unable to resolve WHBAR from router. Set FAUCET_WHBAR_ADDRESS explicitly. Details: ${message}`);
      }
    }
  }

  const normalizedWrappedNative = parseAddress(wrappedNativeAddress, "FAUCET_WHBAR_ADDRESS");
  const candidateFees = orderedCandidateFees(config.poolFee);
  const factory = new Contract(factoryAddress, SAUCER_V2_FACTORY_ABI, provider);
  const checkedFees: number[] = [];

  for (const fee of candidateFees) {
    checkedFees.push(fee);

    try {
      const tickSpacing = await factory.feeAmountTickSpacing.staticCall(fee);
      if (tickSpacing === 0n) {
        continue;
      }
    } catch {
      continue;
    }

    let poolAddress: string;
    try {
      poolAddress = await factory.getPool.staticCall(normalizedWrappedNative, config.usdcAddress, fee);
    } catch {
      continue;
    }

    if (poolAddress !== ZERO_ADDRESS) {
      return {
        hops: [
          {
            tokenIn: normalizedWrappedNative,
            fee,
            tokenOut: config.usdcAddress
          }
        ]
      };
    }
  }

  const multiHopRoute = await findTwoHopRouteFromPoolEvents({
    provider,
    factoryAddress,
    tokenIn: normalizedWrappedNative,
    tokenOut: config.usdcAddress,
    preferredFee: config.poolFee
  });

  if (multiHopRoute) {
    return {
      hops: multiHopRoute
    };
  }

  const checkedFeeText = checkedFees.join(", ");
  throw new Error(`No SaucerSwap V2 route found for ${normalizedWrappedNative} -> ${config.usdcAddress} on factory ${factoryAddress}. Checked direct fee tiers: ${checkedFeeText}.`);
}

export function encodeSaucerV2SingleHopPath(tokenIn: string, fee: number, tokenOut: string): string {
  return encodeSaucerV2Path([tokenIn, tokenOut], [fee]);
}

export function encodeSaucerV2Path(tokens: string[], fees: number[]): string {
  ensureValidPath(tokens, fees);

  const normalizedTokens = tokens.map((token, index) => parseAddress(token, `path token at index ${index}`));
  const normalizedFees = fees.map((fee, index) => {
    if (!Number.isInteger(fee) || fee <= 0 || fee > MAX_UINT24) {
      throw new Error(`Pool fee at index ${index} must be a uint24 integer greater than zero`);
    }
    return fee;
  });

  const types: Array<"address" | "uint24"> = ["address"];
  const values: Array<string | number> = [normalizedTokens[0]];

  for (let i = 0; i < normalizedFees.length; i += 1) {
    types.push("uint24", "address");
    values.push(normalizedFees[i], normalizedTokens[i + 1]);
  }

  return solidityPacked(types, values);
}

export function calculateAmountOutMinimumFromQuote(quotedAmountOut: bigint, slippageBps: bigint): bigint {
  if (quotedAmountOut <= 0n) {
    throw new Error("Quoted amountOut must be greater than zero");
  }
  if (slippageBps < 0n || slippageBps >= BPS_DENOMINATOR) {
    throw new Error("Slippage basis points must be between 0 and 9999");
  }

  const minAmountOut = (quotedAmountOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
  if (minAmountOut <= 0n) {
    throw new Error("Slippage-adjusted minimum output cannot be zero");
  }
  return minAmountOut;
}

export function resolveSaucerV2FaucetConfig(): SaucerV2FaucetConfig {
  const routerAddress = parseAddress(
    process.env.FAUCET_SAUCER_V2_ROUTER_ADDRESS?.trim() || process.env.FAUCET_ROUTER_ADDRESS?.trim() || DEFAULT_SAUCER_V2_ROUTER_ADDRESS,
    "FAUCET_SAUCER_V2_ROUTER_ADDRESS"
  );
  const quoterAddress = parseAddress(
    process.env.FAUCET_SAUCER_V2_QUOTER_ADDRESS?.trim() || DEFAULT_SAUCER_V2_QUOTER_ADDRESS,
    "FAUCET_SAUCER_V2_QUOTER_ADDRESS"
  );
  const configuredWrappedNative = process.env.FAUCET_WHBAR_ADDRESS?.trim();
  const wrappedNativeAddress = configuredWrappedNative ? parseAddress(configuredWrappedNative, "FAUCET_WHBAR_ADDRESS") : null;
  const usdcAddress = parseAddress(process.env.FAUCET_USDC_ADDRESS?.trim() || DEFAULT_USDC_ADDRESS, "FAUCET_USDC_ADDRESS");
  const usdcSymbol = (process.env.FAUCET_USDC_SYMBOL?.trim() || DEFAULT_USDC_SYMBOL) || DEFAULT_USDC_SYMBOL;

  const { operatorId, operatorKey } = resolveAssociationOperatorCredentials();

  return {
    routerAddress,
    quoterAddress,
    wrappedNativeAddress,
    usdcAddress,
    usdcDecimals: resolveUsdcDecimals(),
    usdcSymbol,
    poolFee: resolvePoolFee(),
    slippageBps: resolveSlippageBps(),
    deadlineSeconds: resolveDeadlineSeconds(),
    hederaNetwork: resolveHederaNetworkForAssociation(),
    associationOperatorId: operatorId,
    associationOperatorKey: operatorKey
  };
}

export async function swapHbarToUsdcViaSaucerV2(params: SaucerV2SwapParams, deps: SaucerV2SwapDeps = {}): Promise<SaucerV2SwapResult> {
  const targetUsdcAmount = params.targetUsdcAmount.trim();
  const targetNumeric = Number(targetUsdcAmount);
  if (!Number.isFinite(targetNumeric) || targetNumeric <= 0) {
    throw new Error("Faucet target USDC amount must be a positive number");
  }

  const recipientAddress = parseAddress(params.recipientAddress, "recipientAddress");
  const targetAmountOut = parseUnits(targetUsdcAmount, params.config.usdcDecimals);
  const now = deps.now ?? (() => Date.now());
  const createContracts = deps.createContracts ?? createSaucerV2Contracts;
  const ensureAssociation = deps.ensureRecipientAssociation ?? ensureRecipientTokenAssociation;
  const routeResolver = deps.resolveRoute ?? resolveRoute;

  try {
    await ensureAssociation({
      recipientAccountId: params.recipientAccountId,
      recipientKmsKeyId: params.recipientKmsKeyId,
      tokenAddress: params.config.usdcAddress,
      network: params.config.hederaNetwork,
      operatorId: params.config.associationOperatorId,
      operatorKey: params.config.associationOperatorKey
    });
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Recipient USDC association failed before swap: ${message}`);
  }

  let route: ResolvedSaucerRoute;
  try {
    route = await routeResolver(params.config, params.provider);
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Unable to resolve a valid SaucerSwap V2 route: ${message}`);
  }
  if (route.hops.length === 0) {
    throw new Error("Resolved SaucerSwap route is empty");
  }

  const contracts = createContracts(params.config, params.operatorRunner);
  const tokens = [route.hops[0].tokenIn, ...route.hops.map(hop => hop.tokenOut)];
  const fees = route.hops.map(hop => hop.fee);
  const path = encodeSaucerV2Path(tokens, fees);

  const quoteExactInput = async (quotePath: string, amountIn: bigint): Promise<bigint> => {
    try {
      return await contracts.quoteExactInput(quotePath, amountIn);
    } catch (error) {
      const message = toErrorMessage(error);
      throw new Error(`SaucerSwap V2 quoteExactInput failed: ${message}`);
    }
  };

  const { amountIn, quotedAmountOut } = await resolveAmountInForTargetOut({
    path,
    targetAmountOut,
    slippageBps: params.config.slippageBps,
    quoteExactInput
  });
  const amountOutMinimum = calculateAmountOutMinimumFromQuote(quotedAmountOut, params.config.slippageBps);

  const nowSeconds = BigInt(Math.floor(now() / 1000));
  const deadline = nowSeconds + BigInt(params.config.deadlineSeconds);
  if (deadline <= nowSeconds) {
    throw new Error("Swap deadline must be in the future");
  }

  const exactInputParams: ExactInputParams = {
    path,
    recipient: recipientAddress,
    deadline,
    amountIn,
    amountOutMinimum
  };

  let swapReceipt: { transactionHash: string; status: number | null };
  try {
    swapReceipt = await contracts.exactInput(exactInputParams, amountIn);
  } catch (error) {
    const message = toErrorMessage(error);
    if (hasTokenAssociationFailure(message)) {
      throw new Error(`Swap failed because recipient is not associated with token ${params.config.usdcAddress}: ${message}`);
    }
    throw new Error(`SaucerSwap V2 exactInput failed: ${message}`);
  }

  if (swapReceipt.status !== 1) {
    throw new Error("SaucerSwap V2 swap transaction failed");
  }

  return {
    transactionHash: swapReceipt.transactionHash,
    amountIn,
    quotedAmountOut,
    amountOutMinimum,
    tokenSymbol: params.config.usdcSymbol
  };
}
