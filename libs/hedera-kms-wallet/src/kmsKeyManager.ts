import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  GetPublicKeyCommand,
  KMSClient,
  type CreateKeyCommandInput,
  type KeyMetadata
} from "@aws-sdk/client-kms";

const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;
const IAM_PRINCIPAL_ARN_PATTERN = /^arn:aws[a-zA-Z-]*:iam::\d{12}:(?:root|role\/[\w+=,.@\-_/]+|user\/[\w+=,.@\-_/]+)$/;

export type KmsAuditOperation =
  | "CreateKey"
  | "CreateAlias"
  | "EnableKeyRotation"
  | "DescribeKey"
  | "GetPublicKey"
  | "Sign";
export type KmsAuditStatus = "success" | "failure" | "skipped";

export interface KmsAuditEvent {
  operation: KmsAuditOperation;
  status: KmsAuditStatus;
  timestamp: string;
  keyId?: string;
  keyArn?: string;
  aliasName?: string;
  detail?: string;
}

export type KmsAuditLogger = (event: KmsAuditEvent) => void;

export interface KmsKeyPolicyBindings {
  accountId: string;
  keyAdminPrincipalArn: string;
  runtimeSignerPrincipalArn: string;
}

export interface CreateUserKmsKeyParams {
  kms: KMSClient;
  userId: string;
  descriptionPrefix?: string;
  aliasPrefix?: string;
  tags?: NonNullable<CreateKeyCommandInput["Tags"]>;
  keyPolicy?: Record<string, unknown>;
  policyBindings?: KmsKeyPolicyBindings;
  allowUnsafeDefaultKeyPolicy?: boolean;
  auditLogger?: KmsAuditLogger;
}

export interface UserKmsKeyResult {
  keyId: string;
  keyArn: string;
  aliasName?: string;
  rotationEnabled: boolean;
  rotationNote?: string;
}

export interface ValidatedKmsSigningKey {
  keyId: string;
  keyArn: string;
}

function emitAuditEvent(
  auditLogger: KmsAuditLogger | undefined,
  event: Omit<KmsAuditEvent, "timestamp">
): void {
  if (!auditLogger) {
    return;
  }

  auditLogger({
    ...event,
    timestamp: new Date().toISOString()
  });
}

function normalizeAwsAccountId(accountId: string): string {
  const value = accountId.trim();
  if (!AWS_ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid AWS account id "${accountId}". Expected a 12-digit account id.`);
  }
  return value;
}

function normalizePrincipalArn(principalArn: string, fieldName: string): string {
  const value = principalArn.trim();
  if (!IAM_PRINCIPAL_ARN_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${fieldName} "${principalArn}". Expected an IAM principal ARN like arn:aws:iam::123456789012:role/RoleName.`
    );
  }
  return value;
}

function normalizeTags(
  userId: string,
  tags: NonNullable<CreateKeyCommandInput["Tags"]> | undefined
): NonNullable<CreateKeyCommandInput["Tags"]> {
  const defaultTags: Array<{ TagKey: string; TagValue: string }> = [
    { TagKey: "app", TagValue: "workit" },
    { TagKey: "userId", TagValue: userId }
  ];

  if (!tags) {
    return defaultTags;
  }

  const byTagKey = new Map<string, string>();
  for (const tag of defaultTags) {
    byTagKey.set(tag.TagKey, tag.TagValue);
  }

  for (const tag of tags) {
    if (!tag.TagKey) {
      throw new Error("KMS key tags must include a non-empty TagKey.");
    }

    if (tag.TagValue === undefined) {
      continue;
    }

    if (tag.TagKey === "userId" && tag.TagValue !== userId) {
      throw new Error(`The userId tag must match the normalized user id "${userId}".`);
    }

    byTagKey.set(tag.TagKey, tag.TagValue);
  }

  if (!byTagKey.get("app")) {
    byTagKey.set("app", "workit");
  }
  if (!byTagKey.get("userId")) {
    byTagKey.set("userId", userId);
  }

  return Array.from(byTagKey.entries()).map(([TagKey, TagValue]) => ({ TagKey, TagValue }));
}

function normalizeAliasName(userId: string, aliasPrefix = "alias/workit/user"): string {
  const normalizedUserId = userId.replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/-+/g, "-");

  const trimmedAliasPrefix = aliasPrefix.trim();
  if (!trimmedAliasPrefix) {
    throw new Error("aliasPrefix is required");
  }

  const normalizedPrefix = trimmedAliasPrefix.replace(/^alias\/+/, "");
  const prefix = `alias/${normalizedPrefix}`.replace(/\/+$/, "");
  return `${prefix}/${normalizedUserId}`;
}

function isUnsupportedAsymmetricRotationError(error: unknown): boolean {
  const name = typeof error === "object" && error ? String((error as { name?: unknown }).name ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  const lowerName = name.toLowerCase();
  const lowerMessage = message.toLowerCase();

  return (
    lowerName.includes("unsupportedoperationexception") ||
    lowerName.includes("unsupportedoperation") ||
    (lowerMessage.includes("asymmetric") && lowerMessage.includes("rotation")) ||
    (lowerMessage.includes("automatic rotation") && lowerMessage.includes("not supported"))
  );
}

function resolveCreateKeyPolicy(params: CreateUserKmsKeyParams): Record<string, unknown> | undefined {
  if (params.keyPolicy) {
    return params.keyPolicy;
  }

  if (params.policyBindings) {
    return buildLeastPrivilegeKeyPolicy(params.policyBindings);
  }

  if (params.allowUnsafeDefaultKeyPolicy) {
    return undefined;
  }

  throw new Error(
    "Missing key policy controls. Provide keyPolicy or policyBindings. " +
      "Use allowUnsafeDefaultKeyPolicy=true only for local demos."
  );
}

async function tryEnableRotation(
  kms: KMSClient,
  keyId: string,
  auditLogger?: KmsAuditLogger
): Promise<{ enabled: boolean; note?: string }> {
  try {
    await kms.send(new EnableKeyRotationCommand({ KeyId: keyId }));
    emitAuditEvent(auditLogger, {
      operation: "EnableKeyRotation",
      status: "success",
      keyId
    });
    return { enabled: true };
  } catch (error) {
    if (!isUnsupportedAsymmetricRotationError(error)) {
      emitAuditEvent(auditLogger, {
        operation: "EnableKeyRotation",
        status: "failure",
        keyId,
        detail: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    // Asymmetric SIGN_VERIFY keys do not support automatic rotation in AWS KMS.
    const message = error instanceof Error ? error.message : String(error);
    emitAuditEvent(auditLogger, {
      operation: "EnableKeyRotation",
      status: "skipped",
      keyId,
      detail: message
    });
    return {
      enabled: false,
      note: `Automatic rotation unavailable for this key type. Use managed key replacement + Hedera AccountUpdate for rotation. Detail: ${message}`
    };
  }
}

export async function createUserKmsKey(params: CreateUserKmsKeyParams): Promise<UserKmsKeyResult> {
  const {
    kms,
    userId,
    descriptionPrefix = "Workit Hedera key for user",
    aliasPrefix = "alias/workit/user",
    tags,
    auditLogger
  } = params;
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required");
  }

  const keyPolicy = resolveCreateKeyPolicy(params);
  const createKeyInput: CreateKeyCommandInput = {
    KeySpec: "ECC_SECG_P256K1",
    KeyUsage: "SIGN_VERIFY",
    Description: `${descriptionPrefix} ${normalizedUserId}`,
    Tags: normalizeTags(normalizedUserId, tags)
  };
  if (keyPolicy) {
    createKeyInput.Policy = JSON.stringify(keyPolicy);
  }

  const createResp = await kms.send(new CreateKeyCommand(createKeyInput)).catch(error => {
    emitAuditEvent(auditLogger, {
      operation: "CreateKey",
      status: "failure",
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  });

  const metadata = createResp.KeyMetadata as KeyMetadata | undefined;
  if (!metadata?.KeyId || !metadata.Arn) {
    throw new Error("AWS KMS did not return key metadata");
  }
  emitAuditEvent(auditLogger, {
    operation: "CreateKey",
    status: "success",
    keyId: metadata.KeyId,
    keyArn: metadata.Arn
  });

  const aliasName = normalizeAliasName(normalizedUserId, aliasPrefix);
  try {
    await kms.send(
      new CreateAliasCommand({
        AliasName: aliasName,
        TargetKeyId: metadata.KeyId
      })
    );
    emitAuditEvent(auditLogger, {
      operation: "CreateAlias",
      status: "success",
      keyId: metadata.KeyId,
      keyArn: metadata.Arn,
      aliasName
    });
  } catch (error) {
    emitAuditEvent(auditLogger, {
      operation: "CreateAlias",
      status: "failure",
      keyId: metadata.KeyId,
      keyArn: metadata.Arn,
      aliasName,
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  const rotation = await tryEnableRotation(kms, metadata.KeyId, auditLogger);

  return {
    keyId: metadata.KeyId,
    keyArn: metadata.Arn,
    aliasName,
    rotationEnabled: rotation.enabled,
    rotationNote: rotation.note
  };
}

export function buildLeastPrivilegeKeyPolicy(bindings: KmsKeyPolicyBindings): Record<string, unknown> {
  const accountId = normalizeAwsAccountId(bindings.accountId);
  const keyAdminPrincipalArn = normalizePrincipalArn(bindings.keyAdminPrincipalArn, "keyAdminPrincipalArn");
  const runtimeSignerPrincipalArn = normalizePrincipalArn(bindings.runtimeSignerPrincipalArn, "runtimeSignerPrincipalArn");

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowAccountRootRecovery",
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${accountId}:root`
        },
        Action: "kms:*",
        Resource: "*"
      },
      {
        Sid: "AllowKeyAdministration",
        Effect: "Allow",
        Principal: {
          AWS: keyAdminPrincipalArn
        },
        Action: [
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:PutKeyPolicy",
          "kms:CreateAlias",
          "kms:UpdateAlias",
          "kms:DeleteAlias",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:EnableKey",
          "kms:DisableKey",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion"
        ],
        Resource: "*"
      },
      {
        Sid: "AllowRuntimeSigningOnly",
        Effect: "Allow",
        Principal: {
          AWS: runtimeSignerPrincipalArn
        },
        Action: ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "kms:SigningAlgorithm": "ECDSA_SHA_256"
          }
        }
      }
    ]
  };
}

export async function validateKmsSecp256k1SigningKey(
  kms: KMSClient,
  keyId: string,
  auditLogger?: KmsAuditLogger
): Promise<ValidatedKmsSigningKey> {
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error("keyId is required");
  }

  const response = await kms.send(new DescribeKeyCommand({ KeyId: normalizedKeyId })).catch(error => {
    emitAuditEvent(auditLogger, {
      operation: "DescribeKey",
      status: "failure",
      keyId: normalizedKeyId,
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  });

  const metadata = response.KeyMetadata as KeyMetadata | undefined;
  if (!metadata?.KeyId || !metadata.Arn) {
    throw new Error("KMS did not return key metadata");
  }

  const isKeyEnabled = metadata.Enabled === undefined ? metadata.KeyState === "Enabled" : metadata.Enabled;
  if (!isKeyEnabled || metadata.KeyState !== "Enabled") {
    throw new Error(`KMS key "${metadata.KeyId}" must be in Enabled state for signing.`);
  }
  if (metadata.KeySpec !== "ECC_SECG_P256K1") {
    throw new Error(`KMS key "${metadata.KeyId}" must use KeySpec ECC_SECG_P256K1.`);
  }
  if (metadata.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(`KMS key "${metadata.KeyId}" must use KeyUsage SIGN_VERIFY.`);
  }

  emitAuditEvent(auditLogger, {
    operation: "DescribeKey",
    status: "success",
    keyId: metadata.KeyId,
    keyArn: metadata.Arn
  });

  return {
    keyId: metadata.KeyId,
    keyArn: metadata.Arn
  };
}

export async function getPublicKeyBytes(kms: KMSClient, keyId: string, auditLogger?: KmsAuditLogger): Promise<Buffer> {
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error("keyId is required");
  }

  const response = await kms.send(new GetPublicKeyCommand({ KeyId: normalizedKeyId })).catch(error => {
    emitAuditEvent(auditLogger, {
      operation: "GetPublicKey",
      status: "failure",
      keyId: normalizedKeyId,
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  });

  if (!response.PublicKey) {
    throw new Error("KMS did not return public key bytes");
  }

  emitAuditEvent(auditLogger, {
    operation: "GetPublicKey",
    status: "success",
    keyId: normalizedKeyId
  });

  return Buffer.from(response.PublicKey);
}

export function kmsAccessPolicyGuidance(
  keyArn = "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID",
  aliasArn = "arn:aws:kms:REGION:ACCOUNT_ID:alias/workit/user/*"
) {
  return {
    runtimeSignerPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowSignAndReadPublicMetadata",
          Effect: "Allow",
          Action: ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
          Resource: keyArn,
          Condition: {
            StringEquals: {
              "kms:SigningAlgorithm": "ECDSA_SHA_256"
            }
          }
        }
      ]
    },
    keyAdminPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowCreationOfSecp256k1SigningKeysWithRequiredTags",
          Effect: "Allow",
          Action: ["kms:CreateKey"],
          Resource: "*",
          Condition: {
            StringEquals: {
              "kms:KeySpec": "ECC_SECG_P256K1",
              "kms:KeyUsage": "SIGN_VERIFY",
              "aws:RequestTag/app": "workit"
            },
            "ForAllValues:StringEquals": {
              "aws:TagKeys": ["app", "userId"]
            }
          }
        },
        {
          Sid: "AllowScopedAliasManagement",
          Effect: "Allow",
          Action: ["kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias"],
          Resource: aliasArn
        },
        {
          Sid: "AllowScopedKeyLifecycleManagement",
          Effect: "Allow",
          Action: [
            "kms:TagResource",
            "kms:UntagResource",
            "kms:DescribeKey",
            "kms:GetKeyPolicy",
            "kms:PutKeyPolicy",
            "kms:EnableKey",
            "kms:DisableKey",
            "kms:ScheduleKeyDeletion",
            "kms:CancelKeyDeletion"
          ],
          Resource: keyArn
        }
      ]
    }
  };
}
