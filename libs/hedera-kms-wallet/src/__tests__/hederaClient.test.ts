import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransferTransaction,
  type Transaction
} from "@hashgraph/sdk";
import {
  addKmsSignatureToFrozenTransaction,
  createHederaClient,
  createHederaClientFromEnv,
  executeSignedTransaction,
  getWalletDetails,
  mirrorLinkForTransaction,
  submitTinybarTransferWithKmsSignature,
  submitTopicMessageWithKmsSignature
} from "../hederaClient";
import type { KmsHederaSigner } from "../kmsSigner";

afterEach(() => {
  vi.restoreAllMocks();
});

type FakeSignedTransaction = Transaction & {
  _signedTransactions: {
    list: Array<{ bodyBytes?: Uint8Array }>;
  };
  addSignatureCalls: Array<[unknown, Uint8Array | Uint8Array[]]>;
  addSignature(publicKey: unknown, signature: Uint8Array | Uint8Array[]): void;
};

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const original: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createSigner(overrides?: Partial<KmsHederaSigner>): KmsHederaSigner {
  const privateKey = PrivateKey.generateECDSA();

  return {
    keyId: "kms-key",
    hederaPublicKey: privateKey.publicKey,
    uncompressedPublicKey: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xaa)]),
    compressedPublicKey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xbb)]),
    sign: async () => Buffer.alloc(64, 0x01),
    ...overrides
  };
}

test("createHederaClient parses key formats and network correctly", () => {
  const ecdsaRaw = PrivateKey.generateECDSA().toStringRaw();
  const client1 = createHederaClient({
    network: "testnet",
    operatorId: "0.0.2",
    operatorKey: ecdsaRaw
  });
  assert.equal(client1.operatorAccountId?.toString(), "0.0.2");
  client1.close();

  withEnv({ OPERATOR_KEY_TYPE: "ed25519" }, () => {
    const ed25519Raw = PrivateKey.generateED25519().toStringRaw();
    const client2 = createHederaClient({
      network: "testnet",
      operatorId: "0.0.3",
      operatorKey: ed25519Raw
    });
    assert.equal(client2.operatorAccountId?.toString(), "0.0.3");
    client2.close();
  });

  const derKey = PrivateKey.generateECDSA().toStringDer();
  const client3 = createHederaClient({
    network: "mainnet",
    operatorId: "0.0.4",
    operatorKey: derKey
  });
  assert.equal(client3.networkName, "mainnet");
  client3.close();
});

test("createHederaClient covers explicit and fallback key parsing branches", () => {
  withEnv({ OPERATOR_KEY_TYPE: "ecdsa" }, () => {
    const client = createHederaClient({
      operatorId: "0.0.6",
      operatorKey: PrivateKey.generateECDSA().toStringRaw()
    });
    client.close();
  });

  withEnv({ OPERATOR_KEY_TYPE: "secp256k1" }, () => {
    const client = createHederaClient({
      operatorId: "0.0.7",
      operatorKey: PrivateKey.generateECDSA().toStringRaw()
    });
    client.close();
  });

  withEnv({ OPERATOR_KEY_TYPE: undefined }, () => {
    const client = createHederaClient({
      operatorId: "0.0.8",
      operatorKey: PrivateKey.generateED25519().toStringRaw()
    });
    client.close();
  });

  vi.spyOn(PrivateKey, "fromStringDer").mockImplementation(() => PrivateKey.generateECDSA());
  withEnv({ OPERATOR_KEY_TYPE: "der" }, () => {
    const client = createHederaClient({
      operatorId: "0.0.9",
      operatorKey: PrivateKey.generateECDSA().toStringRaw()
    });
    client.close();
  });

  vi.spyOn(PrivateKey, "fromString").mockImplementation(() => PrivateKey.generateECDSA());
  withEnv({ OPERATOR_KEY_TYPE: undefined }, () => {
    const client = createHederaClient({
      operatorId: "0.0.10",
      operatorKey: "not-a-hex-private-key"
    });
    client.close();
  });
});

test("createHederaClientFromEnv validates env inputs", () => {
  withEnv(
    {
      HEDERA_NETWORK: "mainnet",
      HEDERA_OPERATOR_ID: "0.0.5",
      HEDERA_OPERATOR_KEY: PrivateKey.generateECDSA().toStringRaw(),
      OPERATOR_ID: undefined,
      OPERATOR_KEY: undefined
    },
    () => {
      const result = createHederaClientFromEnv();
      assert.equal(result.network, "mainnet");
      assert.equal(result.operatorId, "0.0.5");
      result.client.close();
    }
  );

  withEnv(
    {
      HEDERA_NETWORK: "testnet",
      HEDERA_OPERATOR_ID: undefined,
      HEDERA_OPERATOR_KEY: undefined,
      OPERATOR_ID: undefined,
      OPERATOR_KEY: undefined
    },
    () => {
      assert.throws(() => createHederaClientFromEnv(), /Missing OPERATOR_ID\/OPERATOR_KEY/);
    }
  );

  withEnv(
    {
      HEDERA_NETWORK: "previewnet",
      OPERATOR_ID: "0.0.2",
      OPERATOR_KEY: PrivateKey.generateECDSA().toStringRaw()
    },
    () => {
      assert.throws(() => createHederaClientFromEnv(), /Unsupported HEDERA_NETWORK "previewnet"/);
    }
  );

  withEnv(
    {
      HEDERA_NETWORK: undefined,
      OPERATOR_ID: "0.0.11",
      OPERATOR_KEY: PrivateKey.generateECDSA().toStringRaw()
    },
    () => {
      const result = createHederaClientFromEnv();
      assert.equal(result.network, "testnet");
      result.client.close();
    }
  );
});

test("getWalletDetails and mirrorLinkForTransaction return expected values", () => {
  assert.deepEqual(getWalletDetails("0.0.100"), { accountId: "0.0.100", network: "testnet" });
  assert.deepEqual(getWalletDetails("0.0.100", "mainnet"), { accountId: "0.0.100", network: "mainnet" });

  const link = mirrorLinkForTransaction("testnet", "0.0.2@1700000000.123456789");
  assert.equal(link, "https://hashscan.io/testnet/transaction/0.0.2%401700000000.123456789");
  assert.throws(() => mirrorLinkForTransaction("testnet", "   "), /transactionId is required/);
});

test("addKmsSignatureToFrozenTransaction handles single and multiple body bytes", async () => {
  const singleTx = {
    _signedTransactions: { list: [{ bodyBytes: Uint8Array.from([1, 2, 3]) }] },
    addSignatureCalls: [] as Array<[unknown, Uint8Array | Uint8Array[]]>,
    addSignature(publicKey: unknown, signature: Uint8Array | Uint8Array[]) {
      this.addSignatureCalls.push([publicKey, signature]);
    }
  } as FakeSignedTransaction;

  const signer = createSigner();
  await addKmsSignatureToFrozenTransaction(singleTx, signer);
  assert.equal(singleTx.addSignatureCalls.length, 1);
  const singleSignature = singleTx.addSignatureCalls[0][1] as Uint8Array;
  assert.equal(singleSignature.length, 64);

  const multiTx = {
    _signedTransactions: { list: [{ bodyBytes: Uint8Array.from([4]) }, { bodyBytes: Uint8Array.from([5]) }] },
    addSignatureCalls: [] as Array<[unknown, Uint8Array | Uint8Array[]]>,
    addSignature(publicKey: unknown, signature: Uint8Array | Uint8Array[]) {
      this.addSignatureCalls.push([publicKey, signature]);
    }
  } as FakeSignedTransaction;

  await addKmsSignatureToFrozenTransaction(multiTx, signer);
  const multiSignatures = multiTx.addSignatureCalls[0][1] as Uint8Array[];
  assert.equal(multiSignatures.length, 2);
  assert.equal(multiSignatures[0].length, 64);
  assert.equal(multiSignatures[1].length, 64);
});

test("addKmsSignatureToFrozenTransaction validates frozen bytes and signature length", async () => {
  const signer = createSigner();
  const noBytesTx = {
    _signedTransactions: { list: [] },
    addSignature() {
      throw new Error("should not be called");
    }
  } as unknown as Transaction;

  await assert.rejects(() => addKmsSignatureToFrozenTransaction(noBytesTx, signer), /No frozen transaction body bytes were found/);

  const badSigner = createSigner({ sign: async () => Uint8Array.from([1, 2, 3]) });
  const tx = {
    _signedTransactions: { list: [{ bodyBytes: Uint8Array.from([1]) }] },
    addSignature() {
      throw new Error("should not be called");
    }
  } as unknown as Transaction;

  await assert.rejects(
    () => addKmsSignatureToFrozenTransaction(tx, badSigner),
    /Signer must return a 64-byte \(r\|\|s\) secp256k1 signature/
  );
});

test("executeSignedTransaction returns response and receipt", async () => {
  const receipt = { status: { toString: () => "SUCCESS" } };
  const response = {
    getReceipt: async () => receipt
  };

  const tx = {
    execute: async () => response
  } as unknown as Transaction;

  const result = await executeSignedTransaction({} as never, tx);
  assert.equal(result.response, response);
  assert.equal(result.receipt, receipt);
});

test("submitTopicMessageWithKmsSignature submits create + message transactions", async () => {
  const operatorKey = PrivateKey.generateECDSA().toStringRaw();
  const client = createHederaClient({
    network: "testnet",
    operatorId: "0.0.2",
    operatorKey
  });

  const signer = createSigner();
  let signCalls = 0;
  signer.sign = async () => {
    signCalls += 1;
    return Buffer.alloc(64, 0x05);
  };

  vi.spyOn(TopicCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000001" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" },
          topicId: { toString: () => "0.0.500" }
        })
      }) as never
  );

  vi.spyOn(TopicMessageSubmitTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000002" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" }
        })
      }) as never
  );

  const result = await submitTopicMessageWithKmsSignature({
    client,
    signer,
    message: "hello from kms test",
    network: "testnet"
  });

  assert.equal(result.topicId, "0.0.500");
  assert.equal(result.receiptStatus, "SUCCESS");
  assert.equal(result.transactionId, "0.0.2@1700000000.000000002");
  assert.match(result.mirrorLink ?? "", /hashscan\.io\/testnet\/transaction/);
  assert.equal(signCalls >= 2, true);
  client.close();
});

test("submitTopicMessageWithKmsSignature requires topic id on creation receipt", async () => {
  const client = createHederaClient({
    network: "testnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw()
  });

  const signer = createSigner();

  vi.spyOn(TopicCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000003" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" }
        })
      }) as never
  );

  await assert.rejects(
    () =>
      submitTopicMessageWithKmsSignature({
        client,
        signer,
        message: "hello"
      }),
    /did not return a topic id/
  );
  client.close();
});

test("submitTinybarTransferWithKmsSignature submits transfer and validates amount", async () => {
  const client = createHederaClient({
    network: "testnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw()
  });

  const signer = createSigner();
  vi.spyOn(TransferTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000010" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" }
        })
      }) as never
  );

  const result = await submitTinybarTransferWithKmsSignature({
    client,
    signer,
    fromAccountId: "0.0.2001",
    toAccountId: "0.0.2002",
    amountTinybar: 10,
    network: "mainnet"
  });

  assert.equal(result.receiptStatus, "SUCCESS");
  assert.equal(result.transactionId, "0.0.2@1700000000.000000010");
  assert.equal(result.mirrorLink, "https://hashscan.io/mainnet/transaction/0.0.2%401700000000.000000010");

  await assert.rejects(
    () =>
      submitTinybarTransferWithKmsSignature({
        client,
        signer,
        fromAccountId: "0.0.2001",
        toAccountId: "0.0.2002",
        amountTinybar: 0
      }),
    /positive safe integer/
  );
  await assert.rejects(
    () =>
      submitTinybarTransferWithKmsSignature({
        client,
        signer,
        fromAccountId: "0.0.2001",
        toAccountId: "0.0.2002",
        amountTinybar: 1.5
      }),
    /positive safe integer/
  );

  client.close();
});
