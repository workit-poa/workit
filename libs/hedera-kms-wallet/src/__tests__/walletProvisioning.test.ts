import { generateKeyPairSync, sign as signWithKey } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand
} from "@aws-sdk/client-kms";
import { AccountCreateTransaction, AccountUpdateTransaction, Client, PrivateKey } from "@hashgraph/sdk";
import { provisionHederaAccountForUser, rotateHederaAccountKmsKey } from "../walletProvisioning";

afterEach(() => {
  vi.restoreAllMocks();
});

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

function buildKmsFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return {
    spkiBytes: publicKey.export({ format: "der", type: "spki" }),
    derSignature: signWithKey("sha256", Buffer.from("wallet-provisioning-test"), privateKey)
  };
}

test("provisionHederaAccountForUser provisions a new key-backed account", async () => {
  const fixture = buildKmsFixture();
  const sentCommands: string[] = [];
  let kmsDestroyed = 0;
  let clientClosed = 0;
  const destroy = KMSClient.prototype.destroy;
  const close = Client.prototype.close;
  const setInitialBalanceSpy = vi.spyOn(AccountCreateTransaction.prototype, "setInitialBalance");

  vi.spyOn(KMSClient.prototype, "destroy").mockImplementation(function (this: KMSClient) {
    kmsDestroyed += 1;
    return destroy.call(this);
  });
  vi.spyOn(Client.prototype, "close").mockImplementation(function (this: Client) {
    clientClosed += 1;
    return close.call(this);
  });
  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    sentCommands.push((command as { constructor: { name: string } }).constructor.name);

    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-abc",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-abc"
        }
      } as never;
    }
    if (command instanceof CreateAliasCommand) {
      return {} as never;
    }
    if (command instanceof EnableKeyRotationCommand) {
      return {} as never;
    }
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-abc",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-abc",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: fixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      assert.equal(command.input.MessageType, "DIGEST");
      assert.equal((command.input.Message as Uint8Array).length, 32);
      return { Signature: fixture.derSignature } as never;
    }

    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        getReceipt: async () => ({
          accountId: { toString: () => "0.0.9001" }
        })
      }) as never
  );

  const result = await provisionHederaAccountForUser({
    userId: "  user:wallet-1  ",
    awsRegion: "us-east-1",
    hederaNetwork: "testnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw(),
    initialHbar: 1,
    allowKeyCreation: true,
    policyBindings: {
      accountId: "123456789012",
      keyAdminPrincipalArn: "arn:aws:iam::123456789012:role/WorkitKmsKeyAdmin",
      runtimeSignerPrincipalArn: "arn:aws:iam::123456789012:role/WorkitRuntimeSigner"
    }
  });

  assert.equal(result.accountId, "0.0.9001");
  assert.equal(result.keyId, "kms-key-abc");
  assert.equal(result.rotationEnabled, true);
  assert.equal(result.aliasName, "alias/workit-user/user-wallet-1");
  assert.equal(result.publicKeyCompressedHex.length, 66);
  assert.equal(result.publicKeyUncompressedHex.length, 130);
  assert.equal(result.publicKeyFingerprint.length, 64);
  assert.equal(kmsDestroyed, 1);
  assert.equal(clientClosed, 1);
  assert.deepEqual(sentCommands.slice(0, 5), [
    "CreateKeyCommand",
    "CreateAliasCommand",
    "EnableKeyRotationCommand",
    "DescribeKeyCommand",
    "GetPublicKeyCommand"
  ]);
  assert.equal(sentCommands.slice(5).every(command => command === "SignCommand"), true);
  assert.equal(sentCommands.filter(command => command === "SignCommand").length > 0, true);
  assert.equal(setInitialBalanceSpy.mock.calls.length, 1);
});

test("provisionHederaAccountForUser supports existing key id path", async () => {
  const fixture = buildKmsFixture();
  const sentCommands: string[] = [];
  const setInitialBalanceSpy = vi.spyOn(AccountCreateTransaction.prototype, "setInitialBalance");

  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    sentCommands.push((command as { constructor: { name: string } }).constructor.name);

    if (command instanceof CreateKeyCommand || command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      throw new Error("new key creation should not run when existingKeyId is provided");
    }
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "existing-kms-key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/existing-kms-key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: fixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      return { Signature: fixture.derSignature } as never;
    }

    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        getReceipt: async () => ({
          accountId: { toString: () => "0.0.9002" }
        })
      }) as never
  );

  const result = await provisionHederaAccountForUser({
    userId: "existing-user",
    awsRegion: "us-east-1",
    hederaNetwork: "testnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw(),
    existingKeyId: "  existing-kms-key-id  ",
    initialHbar: 0
  });

  assert.equal(result.accountId, "0.0.9002");
  assert.equal(result.keyId, "existing-kms-key-id");
  assert.equal(result.keyArn, "arn:aws:kms:us-east-1:123456789012:key/existing-kms-key-id");
  assert.equal(result.aliasName, undefined);
  assert.equal(result.rotationEnabled, false);
  assert.match(result.rotationNote ?? "", /Existing key id was provided/);
  assert.equal(sentCommands[0], "DescribeKeyCommand");
  assert.equal(sentCommands[1], "GetPublicKeyCommand");
  assert.equal(sentCommands.slice(2).every(command => command === "SignCommand"), true);
  assert.equal(sentCommands.filter(command => command === "SignCommand").length > 0, true);
  assert.equal(setInitialBalanceSpy.mock.calls.length, 0);
});

test("provisionHederaAccountForUser reads config defaults from environment", async () => {
  const fixture = buildKmsFixture();
  const setInitialBalanceSpy = vi.spyOn(AccountCreateTransaction.prototype, "setInitialBalance");
  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof CreateKeyCommand || command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      throw new Error("new key creation should not run when existingKeyId is provided");
    }
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "env-key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/env-key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: fixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      return { Signature: fixture.derSignature } as never;
    }
    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        getReceipt: async () => ({
          accountId: { toString: () => "0.0.9003" }
        })
      }) as never
  );

  await withEnv(
    {
      AWS_REGION: "us-east-1",
      HEDERA_NETWORK: "testnet",
      OPERATOR_ID: "0.0.2",
      OPERATOR_KEY: PrivateKey.generateECDSA().toStringRaw(),
      HEDERA_NEW_ACCOUNT_INITIAL_HBAR: "2",
      HEDERA_KMS_ALIAS_PREFIX: "alias/custom-default",
      HEDERA_KMS_KEY_DESCRIPTION_PREFIX: "Custom key prefix"
    },
    async () => {
      const result = await provisionHederaAccountForUser({
        userId: "env-user",
        existingKeyId: "env-key-id",
        initialHbar: Number(process.env.HEDERA_NEW_ACCOUNT_INITIAL_HBAR)
      });
      assert.equal(result.accountId, "0.0.9003");
      assert.equal(result.keyId, "env-key-id");
      assert.equal(setInitialBalanceSpy.mock.calls.length, 1);
    }
  );
});

test("provisionHederaAccountForUser validates required inputs", async () => {
  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "   "
      }),
    /userId is required/
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-1",
        awsRegion: "",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw()
      }),
    /Missing AWS_REGION/
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-1",
        awsRegion: "us-east-1",
        operatorId: "",
        operatorKey: ""
      }),
    /Missing operator credentials/
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-1",
        awsRegion: "us-east-1",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw(),
        initialHbar: -1
      }),
    /initialHbar must be a non-negative number when provided/
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-1",
        awsRegion: "us-east-1",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw(),
        initialHbar: Number.NaN
      }),
    /initialHbar must be a non-negative number when provided/
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-1",
        awsRegion: "us-east-1",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw()
      }),
    /existingKeyId is required unless allowKeyCreation=true/
  );
});

test("rotateHederaAccountKmsKey creates a replacement key and submits account update", async () => {
  const currentFixture = buildKmsFixture();
  const replacementFixture = buildKmsFixture();
  const sentCommands: string[] = [];
  const signKeyIds: string[] = [];
  const destroy = KMSClient.prototype.destroy;
  const close = Client.prototype.close;
  let kmsDestroyed = 0;
  let clientClosed = 0;

  vi.spyOn(KMSClient.prototype, "destroy").mockImplementation(function (this: KMSClient) {
    kmsDestroyed += 1;
    return destroy.call(this);
  });
  vi.spyOn(Client.prototype, "close").mockImplementation(function (this: Client) {
    clientClosed += 1;
    return close.call(this);
  });
  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    sentCommands.push((command as { constructor: { name: string } }).constructor.name);

    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-new",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-new"
        }
      } as never;
    }
    if (command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      return {} as never;
    }
    if (command instanceof DescribeKeyCommand) {
      const keyId = String(command.input.KeyId);
      return {
        KeyMetadata: {
          KeyId: keyId,
          Arn: `arn:aws:kms:us-east-1:123456789012:key/${keyId}`,
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      const keyId = String(command.input.KeyId);
      if (keyId === "kms-key-current") {
        return { PublicKey: currentFixture.spkiBytes } as never;
      }
      return { PublicKey: replacementFixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      const keyId = String(command.input.KeyId);
      signKeyIds.push(keyId);
      if (keyId === "kms-key-current") {
        return { Signature: currentFixture.derSignature } as never;
      }
      return { Signature: replacementFixture.derSignature } as never;
    }

    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountUpdateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000020" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" }
        })
      }) as never
  );

  const result = await rotateHederaAccountKmsKey({
    userId: "rotate-user-1",
    accountId: "0.0.9010",
    currentKeyId: "kms-key-current",
    awsRegion: "us-east-1",
    hederaNetwork: "testnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw(),
    policyBindings: {
      accountId: "123456789012",
      keyAdminPrincipalArn: "arn:aws:iam::123456789012:role/WorkitKmsKeyAdmin",
      runtimeSignerPrincipalArn: "arn:aws:iam::123456789012:role/WorkitRuntimeSigner"
    }
  });

  assert.equal(result.accountId, "0.0.9010");
  assert.equal(result.previousKeyId, "kms-key-current");
  assert.equal(result.keyId, "kms-key-new");
  assert.equal(result.aliasName, "alias/workit-user/rotate-user-1");
  assert.equal(result.rotationEnabled, true);
  assert.equal(result.receiptStatus, "SUCCESS");
  assert.equal(result.transactionId, "0.0.2@1700000000.000000020");
  assert.equal(result.mirrorLink, "https://hashscan.io/testnet/transaction/0.0.2%401700000000.000000020");
  assert.equal(result.previousPublicKeyCompressedHex.length, 66);
  assert.equal(result.publicKeyCompressedHex.length, 66);
  assert.equal(signKeyIds.includes("kms-key-current"), true);
  assert.equal(signKeyIds.includes("kms-key-new"), true);
  assert.equal(
    sentCommands.slice(0, 3).every((command, index) =>
      ["CreateKeyCommand", "CreateAliasCommand", "EnableKeyRotationCommand"][index] === command
    ),
    true
  );
  assert.equal(kmsDestroyed, 1);
  assert.equal(clientClosed, 1);
});

test("rotateHederaAccountKmsKey supports using an existing replacement key id", async () => {
  const currentFixture = buildKmsFixture();
  const replacementFixture = buildKmsFixture();
  const sentCommands: string[] = [];
  const signKeyIds: string[] = [];

  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    sentCommands.push((command as { constructor: { name: string } }).constructor.name);

    if (command instanceof CreateKeyCommand || command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      throw new Error("new key creation should not run when replacementKeyId is provided");
    }
    if (command instanceof DescribeKeyCommand) {
      const keyId = String(command.input.KeyId);
      return {
        KeyMetadata: {
          KeyId: keyId,
          Arn: `arn:aws:kms:us-east-1:123456789012:key/${keyId}`,
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      const keyId = String(command.input.KeyId);
      if (keyId === "kms-key-current") {
        return { PublicKey: currentFixture.spkiBytes } as never;
      }
      return { PublicKey: replacementFixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      const keyId = String(command.input.KeyId);
      signKeyIds.push(keyId);
      if (keyId === "kms-key-current") {
        return { Signature: currentFixture.derSignature } as never;
      }
      return { Signature: replacementFixture.derSignature } as never;
    }

    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountUpdateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        transactionId: { toString: () => "0.0.2@1700000000.000000021" },
        getReceipt: async () => ({
          status: { toString: () => "SUCCESS" }
        })
      }) as never
  );

  const result = await rotateHederaAccountKmsKey({
    userId: "rotate-user-2",
    accountId: "0.0.9011",
    currentKeyId: "kms-key-current",
    replacementKeyId: "kms-key-precreated",
    awsRegion: "us-east-1",
    hederaNetwork: "mainnet",
    operatorId: "0.0.2",
    operatorKey: PrivateKey.generateECDSA().toStringRaw()
  });

  assert.equal(result.keyId, "kms-key-precreated");
  assert.equal(result.aliasName, undefined);
  assert.equal(result.rotationEnabled, false);
  assert.match(result.rotationNote ?? "", /Replacement key id was provided/);
  assert.equal(result.mirrorLink, "https://hashscan.io/mainnet/transaction/0.0.2%401700000000.000000021");
  assert.equal(signKeyIds.includes("kms-key-current"), true);
  assert.equal(signKeyIds.includes("kms-key-precreated"), true);
  assert.equal(sentCommands.some(command => command === "CreateKeyCommand"), false);
});

test("rotateHederaAccountKmsKey validates required inputs", async () => {
  await assert.rejects(
    () =>
      rotateHederaAccountKmsKey({
        userId: "   ",
        accountId: "0.0.1",
        currentKeyId: "kms-key-current"
      }),
    /userId is required/
  );

  await assert.rejects(
    () =>
      rotateHederaAccountKmsKey({
        userId: "user-1",
        accountId: "   ",
        currentKeyId: "kms-key-current"
      }),
    /accountId is required/
  );

  await assert.rejects(
    () =>
      rotateHederaAccountKmsKey({
        userId: "user-1",
        accountId: "0.0.1",
        currentKeyId: "   "
      }),
    /currentKeyId is required/
  );

  await assert.rejects(
    () =>
      rotateHederaAccountKmsKey({
        userId: "user-1",
        accountId: "0.0.1",
        currentKeyId: "kms-key-current",
        awsRegion: "",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw()
      }),
    /Missing AWS_REGION/
  );

  await assert.rejects(
    () =>
      rotateHederaAccountKmsKey({
        userId: "user-1",
        accountId: "0.0.1",
        currentKeyId: "kms-key-current",
        awsRegion: "us-east-1",
        operatorId: "",
        operatorKey: ""
      }),
    /Missing operator credentials/
  );
});

test("provisionHederaAccountForUser throws when account id is missing from receipt", async () => {
  const fixture = buildKmsFixture();

  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-xyz",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-xyz"
        }
      } as never;
    }
    if (command instanceof CreateAliasCommand) {
      return {} as never;
    }
    if (command instanceof EnableKeyRotationCommand) {
      return {} as never;
    }
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-xyz",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-xyz",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      } as never;
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: fixture.spkiBytes } as never;
    }
    if (command instanceof SignCommand) {
      return { Signature: fixture.derSignature } as never;
    }
    throw new Error("Unexpected command");
  });
  vi.spyOn(AccountCreateTransaction.prototype, "execute").mockImplementation(
    async () =>
      ({
        getReceipt: async () => ({})
      }) as never
  );

  await assert.rejects(
    () =>
      provisionHederaAccountForUser({
        userId: "user-2",
        awsRegion: "us-east-1",
        hederaNetwork: "testnet",
        operatorId: "0.0.2",
        operatorKey: PrivateKey.generateECDSA().toStringRaw(),
        allowKeyCreation: true,
        policyBindings: {
          accountId: "123456789012",
          keyAdminPrincipalArn: "arn:aws:iam::123456789012:role/WorkitKmsKeyAdmin",
          runtimeSignerPrincipalArn: "arn:aws:iam::123456789012:role/WorkitRuntimeSigner"
        }
      }),
    /did not return an account id/
  );
});
