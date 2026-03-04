import { SignCommand, KMSClient } from "@aws-sdk/client-kms";
import { PublicKey } from "@hashgraph/sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { compressPublicKey, kmsDerSignatureToHederaRaw64, spkiToUncompressedPublicKey } from "./hederaKeyCodec";
import { getPublicKeyBytes, type KmsAuditLogger, validateKmsSecp256k1SigningKey } from "./kmsKeyManager";

export interface KmsHederaSigner {
  keyId: string;
  keyArn: string;
  hederaPublicKey: PublicKey;
  uncompressedPublicKey: Buffer;
  compressedPublicKey: Buffer;
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface CreateKmsHederaSignerParams {
  kms: KMSClient;
  keyId: string;
  auditLogger?: KmsAuditLogger;
}

export async function createKmsHederaSigner(params: CreateKmsHederaSignerParams): Promise<KmsHederaSigner> {
  const { kms, keyId, auditLogger } = params;
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error("keyId is required");
  }

  const validatedKey = await validateKmsSecp256k1SigningKey(kms, normalizedKeyId, auditLogger);
  const spkiBytes = await getPublicKeyBytes(kms, normalizedKeyId, auditLogger);
  const uncompressedPublicKey = spkiToUncompressedPublicKey(spkiBytes);
  const compressedPublicKey = compressPublicKey(uncompressedPublicKey);
  const hederaPublicKey = PublicKey.fromBytesECDSA(compressedPublicKey);

  const signDigest = async (digestInput: Uint8Array): Promise<Uint8Array> => {
    const digest = Buffer.from(digestInput);
    if (digest.length !== 32) {
      throw new Error("digest must be 32 bytes");
    }
    const response = await kms
      .send(
        new SignCommand({
          KeyId: normalizedKeyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256"
        })
      )
      .catch(error => {
        auditLogger?.({
          operation: "Sign",
          status: "failure",
          timestamp: new Date().toISOString(),
          keyId: normalizedKeyId,
          keyArn: validatedKey.keyArn,
          detail: error instanceof Error ? error.message : String(error)
        });
        throw error;
      });

    if (!response.Signature) {
      auditLogger?.({
        operation: "Sign",
        status: "failure",
        timestamp: new Date().toISOString(),
        keyId: normalizedKeyId,
        keyArn: validatedKey.keyArn,
        detail: "KMS Sign did not return signature bytes"
      });
      throw new Error("KMS Sign did not return signature bytes");
    }
    auditLogger?.({
      operation: "Sign",
      status: "success",
      timestamp: new Date().toISOString(),
      keyId: normalizedKeyId,
      keyArn: validatedKey.keyArn
    });

    return kmsDerSignatureToHederaRaw64(response.Signature);
  };

  const sign = async (message: Uint8Array): Promise<Uint8Array> => {
    // Hedera secp256k1 signatures are verified against keccak256(message).
    // KMS can't do keccak internally, so we provide the digest directly.
    return signDigest(Buffer.from(keccak_256(message)));
  };

  return {
    keyId: normalizedKeyId,
    keyArn: validatedKey.keyArn,
    hederaPublicKey,
    uncompressedPublicKey,
    compressedPublicKey,
    signDigest,
    sign
  };
}
