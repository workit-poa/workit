import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  Transaction,
  type TransactionReceipt,
  type TransactionResponse,
  TransferTransaction
} from "@hashgraph/sdk";
import type { KmsHederaSigner } from "./kmsSigner";
export type HederaNetwork = "testnet" | "mainnet";

export interface WalletDetails {
  accountId: string;
  network: HederaNetwork;
  evmAddress?: string;
}

export interface HederaOperatorConfig {
  network?: HederaNetwork;
  operatorId: string;
  operatorKey: string;
}

export interface HederaSubmitResult {
  transactionId: string;
  receiptStatus: string;
  receipt: TransactionReceipt;
  mirrorLink?: string;
}

function parseNetwork(network?: string): HederaNetwork {
  if (!network || network === "testnet") return "testnet";
  if (network === "mainnet") return "mainnet";
  throw new Error(`Unsupported HEDERA_NETWORK "${network}". Expected "testnet" or "mainnet".`);
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
    // Prefer ECDSA first to match secp256k1 wallet flow used in this project.
    try {
      return PrivateKey.fromStringECDSA(hexValue);
    } catch {
      return PrivateKey.fromStringED25519(hexValue);
    }
  }

  // Non-hex formats (mnemonic/legacy encodings) still require generic parsing.
  return PrivateKey.fromString(value);
}

export function createHederaClient(config: HederaOperatorConfig): Client {
  const network = parseNetwork(config.network);
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(config.operatorId), parseOperatorPrivateKey(config.operatorKey));
  return client;
}

export function getWalletDetails(accountId: string, network: HederaNetwork = "testnet"): WalletDetails {
  return { accountId, network };
}

export function createHederaClientFromEnv(): { client: Client; network: HederaNetwork; operatorId: string } {
  const network = parseNetwork(process.env.HEDERA_NETWORK);
  const operatorId = process.env.OPERATOR_ID || process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY;

  if (!operatorId || !operatorKey) {
    throw new Error("Missing OPERATOR_ID/OPERATOR_KEY (or HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)");
  }

  return {
    client: createHederaClient({ network, operatorId, operatorKey }),
    network,
    operatorId
  };
}

export async function addKmsSignatureToFrozenTransaction(transaction: Transaction, signer: KmsHederaSigner): Promise<void> {
  await transaction.signWith(signer.hederaPublicKey, async bodyBytes => {
    const signature = await signer.sign(bodyBytes);
    if (signature.length !== 64) {
      throw new Error("Signer must return a 64-byte (r||s) secp256k1 signature");
    }
    return signature;
  });
}

export async function executeSignedTransaction<Tx extends Transaction>(
  client: Client,
  transaction: Tx
): Promise<{ response: TransactionResponse; receipt: TransactionReceipt }> {
  const response = await transaction.execute(client);
  const receipt = await response.getReceipt(client);
  return { response, receipt };
}

export async function submitTopicMessageWithKmsSignature(params: {
  client: Client;
  signer: KmsHederaSigner;
  topicMemo?: string;
  message: string;
  network?: HederaNetwork;
}): Promise<HederaSubmitResult & { topicId: string }> {
  const { client, signer, message, topicMemo, network = "testnet" } = params;

  const createTopicTx = await new TopicCreateTransaction()
    .setTopicMemo(topicMemo ?? "workit-kms-demo-topic")
    .setSubmitKey(signer.hederaPublicKey)
    .freezeWith(client);

  await addKmsSignatureToFrozenTransaction(createTopicTx, signer);
  const { response: topicCreateResponse, receipt: topicCreateReceipt } = await executeSignedTransaction(client, createTopicTx);

  const topicId = topicCreateReceipt.topicId?.toString();
  if (!topicId) {
    throw new Error("Topic creation did not return a topic id");
  }

  const submitMessageTx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .freezeWith(client);

  await addKmsSignatureToFrozenTransaction(submitMessageTx, signer);
  const { response, receipt } = await executeSignedTransaction(client, submitMessageTx);

  const transactionId = response.transactionId.toString();
  return {
    topicId,
    transactionId,
    receipt,
    receiptStatus: receipt.status.toString(),
    mirrorLink: mirrorLinkForTransaction(network, transactionId)
  };
}

export async function submitTinybarTransferWithKmsSignature(params: {
  client: Client;
  signer: KmsHederaSigner;
  fromAccountId: string;
  toAccountId: string;
  amountTinybar: number;
  network?: HederaNetwork;
}): Promise<HederaSubmitResult> {
  const { client, signer, fromAccountId, toAccountId, amountTinybar, network = "testnet" } = params;

  if (!Number.isSafeInteger(amountTinybar) || amountTinybar <= 0) {
    throw new Error("amountTinybar must be a positive safe integer");
  }

  const tx = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(fromAccountId), Hbar.fromTinybars(-amountTinybar))
    .addHbarTransfer(AccountId.fromString(toAccountId), Hbar.fromTinybars(amountTinybar))
    .freezeWith(client);

  await addKmsSignatureToFrozenTransaction(tx, signer);
  const { response, receipt } = await executeSignedTransaction(client, tx);

  const transactionId = response.transactionId.toString();

  return {
    transactionId,
    receipt,
    receiptStatus: receipt.status.toString(),
    mirrorLink: mirrorLinkForTransaction(network, transactionId)
  };
}

export function mirrorLinkForTransaction(network: HederaNetwork, transactionId: string): string {
  if (!transactionId.trim()) {
    throw new Error("transactionId is required");
  }
  return `https://hashscan.io/${network}/transaction/${encodeURIComponent(transactionId)}`;
}
