import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  GetPublicKeyCommand,
  type KMSClient
} from "@aws-sdk/client-kms";
import {
  buildLeastPrivilegeKeyPolicy,
  createUserKmsKey,
  getPublicKeyBytes,
  kmsAccessPolicyGuidance,
  validateKmsSecp256k1SigningKey
} from "../kmsKeyManager";

function fakeKms(send: (command: unknown) => Promise<unknown>): KMSClient {
  return { send } as unknown as KMSClient;
}

const policyBindings = {
  accountId: "123456789012",
  keyAdminPrincipalArn: "arn:aws:iam::123456789012:role/WorkitKmsKeyAdmin",
  runtimeSignerPrincipalArn: "arn:aws:iam::123456789012:role/WorkitRuntimeSigner"
} as const;

test("createUserKmsKey creates key, alias, and enables rotation with explicit key policy", async () => {
  const calls: unknown[] = [];
  const auditEvents: Array<{ operation: string; status: string }> = [];
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
    aliasPrefix: "workit/user/",
    policyBindings,
    auditLogger: event => auditEvents.push({ operation: event.operation, status: event.status })
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

  const parsedPolicy = JSON.parse(String(createKey.input.Policy)) as { Statement: Array<{ Sid: string }> };
  assert.equal(parsedPolicy.Statement.some(statement => statement.Sid === "AllowRuntimeSigningOnly"), true);

  const createAlias = calls[1] as CreateAliasCommand;
  assert.equal(createAlias.input.AliasName, "alias/workit/user/user-123");
  assert.equal(createAlias.input.TargetKeyId, "kms-key-123");
  assert.equal(auditEvents.some(event => event.operation === "CreateKey" && event.status === "success"), true);
  assert.equal(auditEvents.some(event => event.operation === "CreateAlias" && event.status === "success"), true);
  assert.equal(auditEvents.some(event => event.operation === "EnableKeyRotation" && event.status === "success"), true);
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
      const error = new Error("Asymmetric keys do not support automatic rotation.");
      (error as Error & { name?: string }).name = "UnsupportedOperationException";
      throw error;
    }
    throw new Error("Unexpected command");
  });

  const result = await createUserKmsKey({
    kms,
    userId: "user-123",
    policyBindings
  });

  assert.equal(result.rotationEnabled, false);
  assert.match(result.rotationNote ?? "", /Automatic rotation unavailable/);
});

test("createUserKmsKey rethrows non-rotation-support errors", async () => {
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
      const error = new Error("Access denied");
      (error as Error & { name?: string }).name = "AccessDeniedException";
      throw error;
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms,
        userId: "user-123",
        policyBindings
      }),
    /Access denied/
  );
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
        userId: "user-123",
        policyBindings
      }),
    /AWS KMS did not return key metadata/
  );

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: kmsWithoutMetadata,
        userId: "   ",
        policyBindings
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
        aliasPrefix: "   ",
        policyBindings
      }),
    /aliasPrefix is required/
  );

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: validMetadataKms,
        userId: "user-123"
      }),
    /Missing key policy controls/
  );

  const explicitPolicyKms = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-789",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-789"
        }
      };
    }
    if (command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });
  const explicitPolicy = {
    Version: "2012-10-17",
    Statement: []
  };
  await createUserKmsKey({
    kms: explicitPolicyKms,
    userId: "user-789",
    keyPolicy: explicitPolicy
  });

  const unsafeKmsCalls: unknown[] = [];
  const unsafeKms = fakeKms(async command => {
    unsafeKmsCalls.push(command);
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-999",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-999"
        }
      };
    }
    if (command instanceof CreateAliasCommand || command instanceof EnableKeyRotationCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });
  await createUserKmsKey({
    kms: unsafeKms,
    userId: "user-999",
    allowUnsafeDefaultKeyPolicy: true
  });
  const unsafeCreateKey = unsafeKmsCalls[0] as CreateKeyCommand;
  assert.equal(unsafeCreateKey.input.Policy, undefined);

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
    policyBindings,
    tags: [{ TagKey: "tenant", TagValue: "t-1" }]
  });
  const createKey = calls[0] as CreateKeyCommand;
  assert.deepEqual(createKey.input.Tags, [
    { TagKey: "app", TagValue: "workit" },
    { TagKey: "userId", TagValue: "user-456" },
    { TagKey: "tenant", TagValue: "t-1" }
  ]);

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: customTagsKms,
        userId: "user-456",
        policyBindings,
        tags: [{ TagKey: "userId", TagValue: "different-user-id" }]
      }),
    /userId tag must match/
  );
});

test("createUserKmsKey emits audit failures for create key and alias failures", async () => {
  const createKeyFailureAudit: Array<{ operation: string; status: string; detail?: string }> = [];
  const createKeyFailureKms = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      throw new Error("CreateKey denied");
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: createKeyFailureKms,
        userId: "user-1",
        policyBindings,
        auditLogger: event => createKeyFailureAudit.push({ operation: event.operation, status: event.status, detail: event.detail })
      }),
    /CreateKey denied/
  );
  assert.equal(
    createKeyFailureAudit.some(
      event => event.operation === "CreateKey" && event.status === "failure" && /CreateKey denied/.test(event.detail ?? "")
    ),
    true
  );

  const aliasFailureAudit: Array<{ operation: string; status: string; detail?: string }> = [];
  const aliasFailureKms = fakeKms(async command => {
    if (command instanceof CreateKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-111",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-111"
        }
      };
    }
    if (command instanceof CreateAliasCommand) {
      throw new Error("CreateAlias denied");
    }
    throw new Error("Unexpected command");
  });
  await assert.rejects(
    () =>
      createUserKmsKey({
        kms: aliasFailureKms,
        userId: "user-111",
        policyBindings,
        auditLogger: event => aliasFailureAudit.push({ operation: event.operation, status: event.status, detail: event.detail })
      }),
    /CreateAlias denied/
  );
  assert.equal(aliasFailureAudit.some(event => event.operation === "CreateKey" && event.status === "success"), true);
  assert.equal(
    aliasFailureAudit.some(
      event => event.operation === "CreateAlias" && event.status === "failure" && /CreateAlias denied/.test(event.detail ?? "")
    ),
    true
  );
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

  await assert.rejects(() => getPublicKeyBytes(kms, "   "), /keyId is required/);

  const missingPublicKeyKms = fakeKms(async command => {
    if (command instanceof GetPublicKeyCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(() => getPublicKeyBytes(missingPublicKeyKms, "key-id"), /did not return public key bytes/);

  const failingAudit: Array<{ operation: string; status: string; detail?: string }> = [];
  const failingKms = fakeKms(async command => {
    if (command instanceof GetPublicKeyCommand) {
      throw new Error("GetPublicKey denied");
    }
    throw new Error("Unexpected command");
  });
  await assert.rejects(
    () =>
      getPublicKeyBytes(failingKms, "key-id", event =>
        failingAudit.push({ operation: event.operation, status: event.status, detail: event.detail })
      ),
    /GetPublicKey denied/
  );
  assert.equal(
    failingAudit.some(
      event => event.operation === "GetPublicKey" && event.status === "failure" && /GetPublicKey denied/.test(event.detail ?? "")
    ),
    true
  );
});

test("validateKmsSecp256k1SigningKey enforces key shape and state", async () => {
  const validKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123",
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    throw new Error("Unexpected command");
  });

  const result = await validateKmsSecp256k1SigningKey(validKms, "kms-key-123");
  assert.equal(result.keyId, "kms-key-123");

  const wrongSpecKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "RSA_2048",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(() => validateKmsSecp256k1SigningKey(wrongSpecKms, "kms-key-123"), /must use KeySpec ECC_SECG_P256K1/);

  const disabledKeyKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123",
          Enabled: false,
          KeyState: "Disabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(() => validateKmsSecp256k1SigningKey(disabledKeyKms, "kms-key-123"), /must be in Enabled state/);

  const wrongUsageKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "kms-key-123",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-123",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "ENCRYPT_DECRYPT"
        }
      };
    }
    throw new Error("Unexpected command");
  });
  await assert.rejects(
    () => validateKmsSecp256k1SigningKey(wrongUsageKms, "kms-key-123"),
    /must use KeyUsage SIGN_VERIFY/
  );

  const missingMetadataKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return { KeyMetadata: {} };
    }
    throw new Error("Unexpected command");
  });
  await assert.rejects(() => validateKmsSecp256k1SigningKey(missingMetadataKms, "kms-key-123"), /did not return key metadata/);

  const failingAudit: Array<{ operation: string; status: string; detail?: string }> = [];
  const describeFailureKms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      throw new Error("DescribeKey denied");
    }
    throw new Error("Unexpected command");
  });
  await assert.rejects(
    () =>
      validateKmsSecp256k1SigningKey(describeFailureKms, "kms-key-123", event =>
        failingAudit.push({ operation: event.operation, status: event.status, detail: event.detail })
      ),
    /DescribeKey denied/
  );
  assert.equal(
    failingAudit.some(
      event => event.operation === "DescribeKey" && event.status === "failure" && /DescribeKey denied/.test(event.detail ?? "")
    ),
    true
  );
});

test("buildLeastPrivilegeKeyPolicy validates bindings", () => {
  const policy = buildLeastPrivilegeKeyPolicy(policyBindings);
  const statements = (policy.Statement as Array<{ Sid: string }>) ?? [];
  assert.equal(statements.length, 3);
  assert.equal(statements.some(statement => statement.Sid === "AllowRuntimeSigningOnly"), true);

  assert.throws(
    () =>
      buildLeastPrivilegeKeyPolicy({
        ...policyBindings,
        accountId: "abc"
      }),
    /Invalid AWS account id/
  );

  assert.throws(
    () =>
      buildLeastPrivilegeKeyPolicy({
        ...policyBindings,
        runtimeSignerPrincipalArn: "not-an-arn"
      }),
    /Invalid runtimeSignerPrincipalArn/
  );
});

test("kmsAccessPolicyGuidance returns scoped policy templates", () => {
  const policy = kmsAccessPolicyGuidance(
    "arn:aws:kms:us-east-1:111122223333:key/abc",
    "arn:aws:kms:us-east-1:111122223333:alias/workit/user/*"
  );
  const defaultPolicy = kmsAccessPolicyGuidance();

  assert.equal(policy.runtimeSignerPolicy.Statement[0].Resource, "arn:aws:kms:us-east-1:111122223333:key/abc");
  assert.deepEqual(policy.runtimeSignerPolicy.Statement[0].Action, ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]);
  assert.equal(policy.keyAdminPolicy.Statement[1].Resource, "arn:aws:kms:us-east-1:111122223333:alias/workit/user/*");
  assert.equal(policy.keyAdminPolicy.Statement[2].Resource, "arn:aws:kms:us-east-1:111122223333:key/abc");
  assert.equal(defaultPolicy.runtimeSignerPolicy.Statement[0].Resource, "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID");
});
