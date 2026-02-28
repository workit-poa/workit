import {
  AccountId,
  Client,
  Hbar,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  Transaction,
  type TransactionReceipt,
  type TransactionResponse,
  TransferTransaction
} from "@hashgraph/sdk";
import type { WalletDetails } from "@workit/common";
import type { KmsHederaSigner } from "./kmsSigner";

export type HederaNetwork = "testnet" | "mainnet";

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
  if (network === "mainnet") return "mainnet";
  return "testnet";
}

export function createHederaClient(config: HederaOperatorConfig): Client {
  const network = parseNetwork(config.network);
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(config.operatorId, config.operatorKey);
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

function extractBodyBytes(transaction: Transaction): Uint8Array[] {
  interface SignedTransactionLike {
    bodyBytes?: Uint8Array;
  }
  interface SignedTransactionsLike {
    list?: SignedTransactionLike[];
  }

  const signedTransactions = (
    transaction as Transaction & {
      _signedTransactions?: SignedTransactionsLike;
    }
  )._signedTransactions;

  const list: SignedTransactionLike[] = signedTransactions?.list ?? [];
  const bytes = list.map(item => item.bodyBytes).filter((value): value is Uint8Array => value !== undefined);

  if (bytes.length === 0) {
    throw new Error("No frozen transaction body bytes were found. Freeze transaction before signing.");
  }

  return bytes;
}

export async function addKmsSignatureToFrozenTransaction(transaction: Transaction, signer: KmsHederaSigner): Promise<void> {
  const bodyBytes = extractBodyBytes(transaction);
  const signatures = await Promise.all(bodyBytes.map(bytes => signer.sign(bytes)));
  transaction.addSignature(signer.hederaPublicKey, signatures.length === 1 ? signatures[0] : signatures);
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

  if (amountTinybar <= 0) {
    throw new Error("amountTinybar must be greater than zero");
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
  return `https://hashscan.io/${network}/transaction/${encodeURIComponent(transactionId)}`;
}
