import { KMSClient } from "@aws-sdk/client-kms";
import {
  AbstractSigner,
  JsonRpcProvider,
  Signature,
  Transaction,
  computeAddress,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  recoverAddress,
  resolveAddress,
  resolveProperties,
  type Provider,
  type TransactionRequest,
  type TransactionLike,
} from "ethers";
import { createKmsHederaSigner, type CreateKmsHederaSignerParams, type KmsHederaSigner } from "./kmsSigner";
import type { HederaNetwork } from "./hederaClient";

export type HederaEvmNetwork = HederaNetwork | "previewnet" | "local";

const HEDERA_EVM_RPC_URLS: Record<HederaEvmNetwork, string> = {
  local: "http://localhost:7546",
  testnet: "https://testnet.hashio.io/api",
  previewnet: "https://previewnet.hashio.io/api",
  mainnet: "https://mainnet.hashio.io/api",
};

const HEDERA_EVM_CHAIN_IDS: Record<HederaEvmNetwork, number> = {
  local: 298,
  testnet: 296,
  previewnet: 297,
  mainnet: 295,
};

const NETWORK_ALIAS_MAP: Record<string, HederaEvmNetwork> = {
  local: "local",
  localhost: "local",
  testnet: "testnet",
  previewnet: "previewnet",
  mainnet: "mainnet",
};

export interface HederaEvmConnectionConfig {
  network?: HederaEvmNetwork;
  rpcUrl?: string;
}

function raw64SignatureToParts(rawSignature: Uint8Array): { r: string; s: string } {
  const bytes = Buffer.from(rawSignature);
  if (bytes.length !== 64) {
    throw new Error("Expected 64-byte secp256k1 signature (r||s).");
  }

  return {
    r: `0x${bytes.subarray(0, 32).toString("hex")}`,
    s: `0x${bytes.subarray(32).toString("hex")}`,
  };
}

export function parseHederaEvmNetwork(value?: string): HederaEvmNetwork {
  const normalized = (value || "testnet").trim().toLowerCase();
  const network = NETWORK_ALIAS_MAP[normalized];
  if (!network) {
    throw new Error(
      `Unsupported Hedera EVM network "${value}". Expected one of: local, testnet, previewnet, mainnet.`,
    );
  }
  return network;
}

export function resolveHederaEvmConnection(config: HederaEvmConnectionConfig = {}): {
  network: HederaEvmNetwork;
  rpcUrl: string;
  chainId: number;
} {
  const network = config.network ?? parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
  const rpcUrl = config.rpcUrl?.trim() || HEDERA_EVM_RPC_URLS[network];
  const chainId = HEDERA_EVM_CHAIN_IDS[network];

  return {
    network,
    rpcUrl,
    chainId,
  };
}

export function evmAddressFromUncompressedPublicKey(uncompressedPublicKey: Uint8Array): string {
  const key = Buffer.from(uncompressedPublicKey);
  if (key.length !== 65 || key[0] !== 0x04) {
    throw new Error("Expected 65-byte uncompressed secp256k1 public key.");
  }

  return getAddress(computeAddress(`0x${key.toString("hex")}`));
}

export function createHederaJsonRpcProvider(config: HederaEvmConnectionConfig = {}): JsonRpcProvider {
  const connection = resolveHederaEvmConnection(config);
  return new JsonRpcProvider(connection.rpcUrl, {
    chainId: connection.chainId,
    name: `hedera-${connection.network}`,
  });
}

interface KmsEvmSignerOptions {
  kmsSigner: KmsHederaSigner;
  provider?: Provider | null;
}

export class KmsEvmSigner extends AbstractSigner {
  readonly kmsSigner: KmsHederaSigner;
  readonly evmAddress: string;

  constructor(options: KmsEvmSignerOptions) {
    super(options.provider ?? undefined);
    this.kmsSigner = options.kmsSigner;
    this.evmAddress = getAddress(options.kmsSigner.hederaPublicKey.toEvmAddress());
  }

  connect(provider: Provider | null): KmsEvmSigner {
    return new KmsEvmSigner({
      kmsSigner: this.kmsSigner,
      provider,
    });
  }

  async getAddress(): Promise<string> {
    return this.evmAddress;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const digest = getBytes(hashMessage(message));
    const signature = await this.signDigestForEvm(digest);
    return signature.serialized;
  }

  async signTransaction(transaction: TransactionRequest): Promise<string> {
    const resolved = await resolveProperties(transaction);
    const to = resolved.to
      ? typeof resolved.to === "string"
        ? resolved.to
        : await resolveAddress(resolved.to, this.provider)
      : resolved.to;

    const txLike: TransactionLike<string> = {
      ...(resolved as unknown as TransactionLike<string>),
      to,
    };

    // Unsigned payloads cannot include `from` in ethers Transaction.from(...)
    delete (txLike as { from?: string | null }).from;

    const tx = Transaction.from(txLike);
    const signature = await this.signDigestForEvm(getBytes(tx.unsignedHash));
    tx.signature = signature;
    return tx.serialized;
  }

  async signTypedData(): Promise<string> {
    throw new Error("Typed data signing is not implemented for KMS signer.");
  }

  private async signDigestForEvm(digest: Uint8Array): Promise<Signature> {
    if (digest.length !== 32) {
      throw new Error("EVM digest must be exactly 32 bytes.");
    }

    const rawSignature = await this.kmsSigner.signDigest(digest);
    const { r, s } = raw64SignatureToParts(rawSignature);
    const digestHex = hexlify(digest);

    for (const yParity of [0, 1] as const) {
      const signature = Signature.from({ r, s, yParity });
      const recovered = recoverAddress(digestHex, signature.serialized);
      if (getAddress(recovered) === this.evmAddress) {
        return signature;
      }
    }

    throw new Error("Unable to derive a valid recovery id for KMS EVM signature.");
  }
}

export interface CreateKmsEvmSignerParams extends CreateKmsHederaSignerParams {
  provider?: Provider | null;
}

export async function createKmsEvmSigner(params: CreateKmsEvmSignerParams): Promise<KmsEvmSigner> {
  const kmsSigner = await createKmsHederaSigner(params);
  return new KmsEvmSigner({
    kmsSigner,
    provider: params.provider,
  });
}

export interface SignEvmTransactionWithKmsWalletParams extends CreateKmsEvmSignerParams {
  transaction: TransactionRequest;
}

export interface SignedEvmTransactionWithKmsWalletResult {
  signedTransaction: string;
  from: string;
}

export async function signEvmTransactionWithKmsWallet(
  params: SignEvmTransactionWithKmsWalletParams,
): Promise<SignedEvmTransactionWithKmsWalletResult> {
  const signer = await createKmsEvmSigner({
    kms: params.kms,
    keyId: params.keyId,
    auditLogger: params.auditLogger,
    provider: params.provider,
  });

  const signedTransaction = await signer.signTransaction(params.transaction);
  return {
    signedTransaction,
    from: await signer.getAddress(),
  };
}

export function createKmsClientFromEnv(): KMSClient {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error("Missing AWS_REGION (or AWS_DEFAULT_REGION) for KMS client.");
  }

  return new KMSClient({ region });
}
