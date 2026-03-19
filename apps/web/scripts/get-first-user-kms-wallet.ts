import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getManagedWalletSignerContext, users } from "@workit-poa/auth";
import {
  AccountBalanceQuery,
  AccountId,
  Hbar,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";
import {
  createHederaClientFromEnv,
  createHederaJsonRpcProvider,
  createKmsClientFromEnv,
  createKmsEvmSigner,
  parseHederaEvmNetwork,
} from "@workit-poa/hedera-kms-wallet";
import { Contract, Interface, formatUnits, getAddress, isAddress, type InterfaceAbi } from "ethers";
import whbarAbiJson from "./WHBAR.json";
import {
  ensureTokenAssociationWithKms,
  resolveTokenIdFromAddress,
} from "../lib/hedera/token-association";

const HBAR_DECIMALS = 8;
const HBAR_WEI_DECIMALS = 18;
const ONE_HBAR_TINYBARS = 100_000_000n;
const ONE_HBAR_TINYBARS_NUMBER = 100_000_000;
const ONE_HBAR_WEI = 10n ** BigInt(HBAR_WEI_DECIMALS);
const TOP_UP_TINYBARS = 200_000_000n;
const TOP_UP_TINYBARS_NUMBER = 200_000_000;
const DEFAULT_DEPOSIT_GAS_LIMIT = 180_000n;
const TESTNET_WHBAR_ADDRESS = "0x0000000000000000000000000000000000003ad1";
const DEFAULT_MIN_GAS_PRICE_WEI = 910_000_000_000n;

function resolveWhbarAbiFromJson(input: unknown): InterfaceAbi {
  if (Array.isArray(input)) return input as InterfaceAbi;
  if (input && typeof input === "object" && "abi" in input) {
    const abi = (input as { abi?: unknown }).abi;
    if (Array.isArray(abi)) return abi as InterfaceAbi;
  }
  throw new Error("WHBAR.json must export an ABI array or an object containing an abi array");
}

const WHBAR_ABI = resolveWhbarAbiFromJson(whbarAbiJson);
const whbarInterface = new Interface(WHBAR_ABI);
const standardErrorInterface = new Interface([
  "error Error(string)",
  "error Panic(uint256)",
]);

interface FirstUserRecord {
  id: string;
  email: string | null;
  createdAt: Date;
}

type HederaClient = ReturnType<typeof createHederaClientFromEnv>["client"];

function parseEnvLine(rawLine: string): [string, string] | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
  const delimiterIndex = normalized.indexOf("=");
  if (delimiterIndex <= 0) return null;

  const key = normalized.slice(0, delimiterIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = normalized.slice(delimiterIndex + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

async function loadEnvFiles(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(scriptDir, "../.env.local"),
    resolve(scriptDir, "../.env"),
    resolve(process.cwd(), "apps/web/.env.local"),
    resolve(process.cwd(), "apps/web/.env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
  ];

  const seen = new Set<string>();
  for (const filePath of candidates) {
    if (seen.has(filePath) || !existsSync(filePath)) continue;
    seen.add(filePath);

    const contents = await readFile(filePath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const parsed = parseEnvLine(rawLine);
      if (!parsed) continue;

      const [key, value] = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function tinybarsToHbar(amountTinybars: bigint): string {
  return formatUnits(amountTinybars, HBAR_DECIMALS);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeTokenTransferFailure(message: string): boolean {
  return message.toLowerCase().includes("safe token transfer failed");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseBigIntEnv(name: string): bigint | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer wei value`);
  }
  return BigInt(raw);
}

function isHexData(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function extractRevertData(error: unknown, depth = 0): string | null {
  if (depth > 6 || error == null) return null;

  if (isHexData(error)) {
    return error === "0x" ? null : error;
  }

  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as unknown;
      return extractRevertData(parsed, depth + 1);
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

  const nestedKeys = ["error", "info", "cause", "value", "result", "response", "receipt"];
  for (const key of nestedKeys) {
    if (key in record) {
      const nested = extractRevertData(record[key], depth + 1);
      if (nested) return nested;
    }
  }

  if (typeof record.body === "string") {
    try {
      const parsed = JSON.parse(record.body) as unknown;
      const nested = extractRevertData(parsed, depth + 1);
      if (nested) return nested;
    } catch {
      // Ignore invalid JSON payload bodies.
    }
  }

  return null;
}

function decodeRevertData(revertData: string, interfaces: Interface[]): string {
  for (const iface of interfaces) {
    try {
      const parsed = iface.parseError(revertData);
      if (parsed) {
        const args = parsed.args
          .map(arg => (typeof arg === "bigint" ? arg.toString() : String(arg)))
          .join(", ");
        return `${parsed.name}(${args})`;
      }
    } catch {
      // Continue trying interfaces.
    }
  }

  return `revertData=${revertData}`;
}

function decodeEvmError(error: unknown, interfaces: Interface[]): string | null {
  const revertData = extractRevertData(error);
  if (!revertData) return null;
  return decodeRevertData(revertData, [...interfaces, standardErrorInterface]);
}

async function resolveGasPriceWei(provider: ReturnType<typeof createHederaJsonRpcProvider>): Promise<bigint> {
  const explicitGasPrice = parseBigIntEnv("HEDERA_EVM_GAS_PRICE_WEI");
  if (explicitGasPrice !== null) {
    if (explicitGasPrice <= 0n) {
      throw new Error("HEDERA_EVM_GAS_PRICE_WEI must be greater than zero");
    }
    return explicitGasPrice;
  }

  const configuredMin = parseBigIntEnv("HEDERA_EVM_MIN_GAS_PRICE_WEI") ?? DEFAULT_MIN_GAS_PRICE_WEI;
  if (configuredMin <= 0n) {
    throw new Error("HEDERA_EVM_MIN_GAS_PRICE_WEI must be greater than zero");
  }

  const feeData = await provider.getFeeData();
  const candidate = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  return candidate > configuredMin ? candidate : configuredMin;
}

function resolveWhbarAddressForTestnet(): string {
  const configured = process.env.LAUNCHPAD_WHBAR_ADDRESS?.trim();
  const candidate = configured && configured.length > 0 ? configured : TESTNET_WHBAR_ADDRESS;

  if (isAddress(candidate)) {
    return getAddress(candidate);
  }

  try {
    const solidityHex = TokenId.fromString(candidate).toSolidityAddress();
    return getAddress(`0x${solidityHex}`);
  } catch {
    throw new Error("LAUNCHPAD_WHBAR_ADDRESS must be a valid EVM address or Hedera token id");
  }
}

async function fetchNthUser(userOrdinal: number): Promise<FirstUserRecord | null> {
  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt)
    .offset(userOrdinal - 1)
    .limit(1);

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
  };
}

async function getNativeHbarBalanceTinybars(client: HederaClient, accountId: string): Promise<bigint> {
  const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client as never);
  return BigInt(balance.hbars.toTinybars().toString());
}

async function getHtsTokenBalanceTinybars(params: {
  client: HederaClient;
  accountId: string;
  tokenId: TokenId;
}): Promise<bigint> {
  const balance = await new AccountBalanceQuery()
    .setAccountId(params.accountId)
    .execute(params.client as never);
  const tokenBalance = balance.tokens?.get(params.tokenId);
  return BigInt(tokenBalance?.toString() ?? "0");
}

async function topUpWalletWithOperator(params: {
  client: HederaClient;
  operatorId: string;
  targetAccountId: string;
}): Promise<string> {
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(params.operatorId), Hbar.fromTinybars(-TOP_UP_TINYBARS_NUMBER))
    .addHbarTransfer(AccountId.fromString(params.targetAccountId), Hbar.fromTinybars(TOP_UP_TINYBARS_NUMBER));

  const response = await tx.execute(params.client as never);
  const receipt = await response.getReceipt(params.client as never);
  const status = receipt.status.toString();

  if (status !== "SUCCESS") {
    throw new Error(`Operator top-up failed with status: ${status}`);
  }

  return response.transactionId.toString();
}

async function depositOneHbarIntoWhbar(params: {
  hederaClient: HederaClient;
  hederaAccountId: string;
  kmsKeyId: string;
  whbarAddress: string;
}): Promise<{
  walletEvmAddress: string;
  whbarTokenAddress: string;
  whbarTokenId: string;
  associationTxId: string | null;
  whbarBeforeTinybars: bigint;
  whbarAfterTinybars: bigint;
}> {
  const rpcUrl = process.env.HEDERA_EVM_RPC_URL?.trim();
  const provider = createHederaJsonRpcProvider({
    network: "testnet",
    rpcUrl: rpcUrl && rpcUrl.length > 0 ? rpcUrl : undefined,
  });
  const kms = createKmsClientFromEnv();

  try {
    const signer = await createKmsEvmSigner({
      kms,
      keyId: params.kmsKeyId,
      provider,
    });
    const walletEvmAddress = await signer.getAddress();
    const whbarContract = new Contract(params.whbarAddress, WHBAR_ABI, provider);
    const whbarTokenAddress = getAddress(await whbarContract.token());
    const whbarTokenIdRaw = resolveTokenIdFromAddress(whbarTokenAddress);
    if (!whbarTokenIdRaw) {
      throw new Error(`Unable to resolve WHBAR token ID from address ${whbarTokenAddress}`);
    }
    const whbarTokenId = TokenId.fromString(whbarTokenIdRaw);
    const associationTxId = await ensureTokenAssociationWithKms({
      hederaClient: params.hederaClient,
      hederaAccountId: params.hederaAccountId,
      tokenId: whbarTokenId,
      kms,
      kmsKeyId: params.kmsKeyId,
    });

    const whbarBeforeTinybars = await getHtsTokenBalanceTinybars({
      client: params.hederaClient,
      accountId: params.hederaAccountId,
      tokenId: whbarTokenId,
    });

    const nonce = await provider.getTransactionCount(walletEvmAddress, "pending");
    const network = await provider.getNetwork();
    const data = whbarInterface.encodeFunctionData("deposit()");
    const depositTxRequest = {
      from: walletEvmAddress,
      to: params.whbarAddress,
      data,
      value: ONE_HBAR_WEI,
    };
    const estimatedGas = await provider.estimateGas(depositTxRequest).catch(error => {
      const decoded = decodeEvmError(error, [whbarInterface]);
      if (decoded) {
        throw new Error(`WHBAR deposit preflight failed: ${decoded}`);
      }
      return DEFAULT_DEPOSIT_GAS_LIMIT;
    });
    const gasLimit = estimatedGas > 0n ? (estimatedGas * 120n) / 100n : DEFAULT_DEPOSIT_GAS_LIMIT;
    const gasPrice = await resolveGasPriceWei(provider);

    const signedTx = await signer.signTransaction({
      chainId: BigInt(network.chainId),
      from: walletEvmAddress,
      to: params.whbarAddress,
      nonce,
      data,
      value: ONE_HBAR_WEI,
      gasLimit,
      gasPrice,
    });

    const response = await provider.broadcastTransaction(signedTx).catch(error => {
      const decoded = decodeEvmError(error, [whbarInterface]);
      if (decoded) {
        throw new Error(`WHBAR deposit broadcast failed: ${decoded}`);
      }
      throw new Error(`WHBAR deposit broadcast failed: ${toErrorMessage(error)}`);
    });

    const receipt = await response.wait().catch(async error => {
      const decoded = decodeEvmError(error, [whbarInterface]);
      if (decoded) {
        throw new Error(`WHBAR deposit execution failed: ${decoded}`);
      }

      const simulated = await provider.call(depositTxRequest).catch(callError => decodeEvmError(callError, [whbarInterface]));
      if (simulated) {
        throw new Error(`WHBAR deposit execution reverted: ${simulated}`);
      }

      throw new Error(`WHBAR deposit execution failed: ${toErrorMessage(error)}`);
    });

    if (!receipt || receipt.status !== 1) {
      const simulated = await provider.call(depositTxRequest).catch(error => decodeEvmError(error, [whbarInterface]));
      if (simulated) {
        throw new Error(`WHBAR deposit reverted: ${simulated}`);
      }
      throw new Error("WHBAR deposit transaction did not succeed");
    }

    const whbarAfterTinybars = await getHtsTokenBalanceTinybars({
      client: params.hederaClient,
      accountId: params.hederaAccountId,
      tokenId: whbarTokenId,
    });
    if (whbarAfterTinybars < whbarBeforeTinybars + ONE_HBAR_TINYBARS) {
      throw new Error(
        `WHBAR balance did not increase by at least 1 HBAR. Before=${whbarBeforeTinybars.toString()}, After=${whbarAfterTinybars.toString()}`
      );
    }

    return {
      walletEvmAddress,
      whbarTokenAddress,
      whbarTokenId: whbarTokenId.toString(),
      associationTxId,
      whbarBeforeTinybars,
      whbarAfterTinybars,
    };
  } finally {
    kms.destroy();
  }
}

async function main(): Promise<void> {
  await loadEnvFiles();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing. Set it directly or in apps/web/.env");
  }
  const hederaEvmNetwork = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
  if (hederaEvmNetwork !== "testnet") {
    throw new Error(`This script only supports Hedera testnet. Current HEDERA_NETWORK: ${hederaEvmNetwork}`);
  }

  const userOrdinal = 3
  const user = await fetchNthUser(userOrdinal);

  if (!user) {
    console.log(`No user found at position ${userOrdinal}.`);
    return;
  }

  const wallet = await getManagedWalletSignerContext(user.id);
  const whbarAddress = resolveWhbarAddressForTestnet();
  const { client: operatorClient, operatorId } = createHederaClientFromEnv();

  try {
    let nativeBeforeTinybars = await getNativeHbarBalanceTinybars(operatorClient, wallet.hederaAccountId);
    let topUpTxId: string | null = null;

    if (nativeBeforeTinybars < ONE_HBAR_TINYBARS) {
      topUpTxId = await topUpWalletWithOperator({
        client: operatorClient,
        operatorId,
        targetAccountId: wallet.hederaAccountId,
      });
      nativeBeforeTinybars = await getNativeHbarBalanceTinybars(operatorClient, wallet.hederaAccountId);
    }

    if (nativeBeforeTinybars < ONE_HBAR_TINYBARS) {
      throw new Error(
        `Wallet still has less than 1 HBAR after top-up attempt: ${nativeBeforeTinybars.toString()} tinybars`
      );
    }

    const depositResult = await depositOneHbarIntoWhbar({
      hederaClient: operatorClient,
      hederaAccountId: wallet.hederaAccountId,
      kmsKeyId: wallet.kmsKeyId,
      whbarAddress,
    });
    const nativeAfterTinybars = await getNativeHbarBalanceTinybars(operatorClient, wallet.hederaAccountId);

    await process
    console.log(
      JSON.stringify(
        {
          user: {
            id: user.id,
            email: user.email,
            createdAt: user.createdAt?.toISOString() ?? null,
          },
          kmsWallet: wallet,
          checks: {
            minimumRequiredHbar: "1",
            topUpAmountIfBelowMinimumHbar: "2",
            hbarBeforeDeposit: tinybarsToHbar(nativeBeforeTinybars),
            hbarAfterDeposit: tinybarsToHbar(nativeAfterTinybars),
            topUpTransactionId: topUpTxId,
          },
          whbarDeposit: {
            network: "testnet",
            whbarAddress,
            whbarTokenAddress: depositResult.whbarTokenAddress,
            whbarTokenId: depositResult.whbarTokenId,
            associationTxId: depositResult.associationTxId,
            depositorEvmAddress: depositResult.walletEvmAddress,
            depositedHbar: "1",
            whbarBefore: tinybarsToHbar(depositResult.whbarBeforeTinybars),
            whbarAfter: tinybarsToHbar(depositResult.whbarAfterTinybars),
          },
        },
        null,
        2
      )
    );
  } finally {
    operatorClient.close();
  }
}

async function closeDbClient(): Promise<void> {
  const globals = globalThis as typeof globalThis & {
    __workit_sql_client__?: { end?: (options?: { timeout?: number }) => Promise<unknown> };
  };

  if (globals.__workit_sql_client__?.end) {
    await globals.__workit_sql_client__.end({ timeout: 5 });
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to fetch user KMS wallet: ${message}`);
    if (error instanceof Error && "cause" in error && (error as Error & { cause?: unknown }).cause) {
      console.trace("Cause:", (error as Error & { cause?: unknown }).cause);
    }
    process.exitCode = 1;
  } finally {
    await closeDbClient();
  }
}

void run();
