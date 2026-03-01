import {
  CreateAliasCommand,
  CreateKeyCommand,
  EnableKeyRotationCommand,
  GetPublicKeyCommand,
  KMSClient,
  type CreateKeyCommandInput,
  type KeyMetadata
} from "@aws-sdk/client-kms";

export interface CreateUserKmsKeyParams {
  kms: KMSClient;
  userId: string;
  descriptionPrefix?: string;
  aliasPrefix?: string;
  tags?: NonNullable<CreateKeyCommandInput["Tags"]>;
}

export interface UserKmsKeyResult {
  keyId: string;
  keyArn: string;
  aliasName?: string;
  rotationEnabled: boolean;
  rotationNote?: string;
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

async function tryEnableRotation(kms: KMSClient, keyId: string): Promise<{ enabled: boolean; note?: string }> {
  try {
    await kms.send(new EnableKeyRotationCommand({ KeyId: keyId }));
    return { enabled: true };
  } catch (error) {
    // Asymmetric SIGN_VERIFY keys do not support automatic rotation in AWS KMS.
    const message = error instanceof Error ? error.message : String(error);
    return {
      enabled: false,
      note: `Automatic rotation unavailable for this key type. Use managed key replacement + Hedera AccountUpdate for rotation. Detail: ${message}`
    };
  }
}

export async function createUserKmsKey(params: CreateUserKmsKeyParams): Promise<UserKmsKeyResult> {
  const { kms, userId, descriptionPrefix = "Workit Hedera key for user", aliasPrefix = "alias/workit/user", tags } = params;
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required");
  }

  const createResp = await kms.send(
    new CreateKeyCommand({
      KeySpec: "ECC_SECG_P256K1",
      KeyUsage: "SIGN_VERIFY",
      Description: `${descriptionPrefix} ${normalizedUserId}`,
      Tags: tags ?? [
        { TagKey: "app", TagValue: "workit" },
        { TagKey: "userId", TagValue: normalizedUserId }
      ]
    })
  );

  const metadata = createResp.KeyMetadata as KeyMetadata | undefined;
  if (!metadata?.KeyId || !metadata.Arn) {
    throw new Error("AWS KMS did not return key metadata");
  }

  const aliasName = normalizeAliasName(normalizedUserId, aliasPrefix);
  await kms.send(
    new CreateAliasCommand({
      AliasName: aliasName,
      TargetKeyId: metadata.KeyId
    })
  );

  const rotation = await tryEnableRotation(kms, metadata.KeyId);

  return {
    keyId: metadata.KeyId,
    keyArn: metadata.Arn,
    aliasName,
    rotationEnabled: rotation.enabled,
    rotationNote: rotation.note
  };
}

export async function getPublicKeyBytes(kms: KMSClient, keyId: string): Promise<Buffer> {
  const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!response.PublicKey) {
    throw new Error("KMS did not return public key bytes");
  }
  return Buffer.from(response.PublicKey);
}

export function kmsAccessPolicyGuidance(keyArn = "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID") {
  return {
    runtimeSignerPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowSignAndReadPublicMetadata",
          Effect: "Allow",
          Action: ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
          Resource: keyArn
        }
      ]
    },
    keyAdminPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowKmsKeyLifecycleManagement",
          Effect: "Allow",
          Action: [
            "kms:CreateKey",
            "kms:CreateAlias",
            "kms:UpdateAlias",
            "kms:TagResource",
            "kms:DescribeKey",
            "kms:GetKeyPolicy",
            "kms:PutKeyPolicy",
            "kms:ScheduleKeyDeletion",
            "kms:CancelKeyDeletion"
          ],
          Resource: "*"
        }
      ]
    }
  };
}
