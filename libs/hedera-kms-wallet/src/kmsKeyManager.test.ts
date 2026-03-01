import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  EnableKeyRotationCommand,
  GetPublicKeyCommand,
  type KMSClient
} from "@aws-sdk/client-kms";
import { createUserKmsKey, getPublicKeyBytes, kmsAccessPolicyGuidance } from "./kmsKeyManager";

function fakeKms(send: (command: unknown) => Promise<unknown>): KMSClient {
  return { send } as unknown as KMSClient;
}

test("createUserKmsKey creates key, alias, and enables rotation", async () => {
  const calls: unknown[] = [];
  const kms = fakeKms(async command => {
    calls.push(command);

    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123"
        }
      };
    }
    if (command instanceof CreateAliasCommand) {
      return {};
    }
    if (command instanceof EnableKeyRotationCommand) {
      return {};
    }

    throw new Error(`Unexpected command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`);
  });

  const result = await createUserKmsKey({
    kms,
    userId: " user:123 ",
    aliasPrefix: "workit/user/"
  });

  assert.equal(result.keyId, "kms-key-123");
  assert.equal(result.rotationEnabled, true);
  assert.equal(result.aliasName, "alias/workit/user/user-123");

  const createKey = calls[0] as CreateKeyCommand;
  assert.equal(createKey.input.KeySpec, "ECC_SECG_P256K1");
  assert.equal(createKey.input.KeyUsage, "SIGN_VERIFY");
  assert.equal(createKey.input.Description, "Workit Hedera key for user user:123");
  assert.deepEqual(createKey.input.Tags, [
    { TagKey: "app", TagValue: "workit" },
    { TagKey: "userId", TagValue: "user:123" }
  ]);

  const createAlias = calls[1] as CreateAliasCommand;
  assert.equal(createAlias.input.AliasName, "alias/workit/user/user-123");
  assert.equal(createAlias.input.TargetKeyId, "kms-key-123");
});

test("createUserKmsKey returns rotation guidance when rotation is unsupported", async () => {
  const kms = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123"
        }
      };
    }
    if (command instanceof CreateAliasCommand) {
      return {};
    }
    if (command instanceof EnableKeyRotationCommand) {
      throw new Error("UnsupportedOperationException");
    }
    throw new Error("Unexpected command");
  });

  const result = await createUserKmsKey({
    kms,
    userId: "user-123"
  });

  assert.equal(result.rotationEnabled, false);
  assert.match(result.rotationNote ?? "", /Automatic rotation unavailable/);
  assert.match(result.rotationNote ?? "", /UnsupportedOperationException/);
});

test("createUserKmsKey validates required inputs and metadata", async () => {
  const kmsWithoutMetadata = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      return { KeyMetadata: {} };
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: kmsWithoutMetadata,
        userId: "user-123"
      }),
    /AWS KMS did not return key metadata/
  );

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: kmsWithoutMetadata,
        userId: "   "
      }),
    /userId is required/
  );

  const validMetadataKms = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123"
        }
      };
    }
    if (command instanceof CreateAliasCommand) {
      return {};
    }
    if (command instanceof EnableKeyRotationCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: validMetadataKms,
        userId: "user-123",
        aliasPrefix: "   "
      }),
    /aliasPrefix is required/
  );

  const calls: unknown[] = [];
  const customTagsKms = fakeKms(async command => {
    calls.push(command);
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-456",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-456"
        }
      };
    }
    if (command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });

  await createUserKmsKey({
    kms: customTagsKms,
    userId: "user-456",
    tags: [{ TagKey: "tenant", TagValue: "t-1" }]
  });
  const createKey = calls[0] as CreateKeyCommand;
  assert.deepEqual(createKey.input.Tags, [{ TagKey: "tenant", TagValue: "t-1" }]);
});

test("getPublicKeyBytes returns bytes and throws when missing", async () => {
  const kms = fakeKms(async command => {
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: Uint8Array.from([1, 2, 3]) };
    }
    throw new Error("Unexpected command");
  });

  const bytes = await getPublicKeyBytes(kms, "key-id");
  assert.deepEqual(Buffer.from(bytes), Buffer.from([1, 2, 3]));

  const missingPublicKeyKms = fakeKms(async command => {
    if (command instanceof GetPublicKeyCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(() => getPublicKeyBytes(missingPublicKeyKms, "key-id"), /did not return public key bytes/);
});

test("kmsAccessPolicyGuidance returns scoped policy templates", () => {
  const policy = kmsAccessPolicyGuidance("arn:aws:kms:us-east-1:111122223333:key/abc");
  const defaultPolicy = kmsAccessPolicyGuidance();

  assert.equal(policy.runtimeSignerPolicy.Statement[0].Resource, "arn:aws:kms:us-east-1:111122223333:key/abc");
  assert.deepEqual(policy.runtimeSignerPolicy.Statement[0].Action, ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]);
  assert.equal(policy.keyAdminPolicy.Statement[0].Resource, "*");
  assert.equal(defaultPolicy.runtimeSignerPolicy.Statement[0].Resource, "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID");
});
