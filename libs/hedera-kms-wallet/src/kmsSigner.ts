import { SignCommand, KMSClient } from "@aws-sdk/client-kms";
import { PublicKey } from "@hashgraph/sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { compressPublicKey, kmsDerSignatureToHederaRaw64, spkiToUncompressedPublicKey } from "./hederaKeyCodec";
import { getPublicKeyBytes } from "./kmsKeyManager";

export interface KmsHederaSigner {
  keyId: string;
  hederaPublicKey: PublicKey;
  uncompressedPublicKey: Buffer;
  compressedPublicKey: Buffer;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

export async function createKmsHederaSigner(kms: KMSClient, keyId: string): Promise<KmsHederaSigner> {
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error("keyId is required");
  }

  const spkiBytes = await getPublicKeyBytes(kms, normalizedKeyId);
  const uncompressedPublicKey = spkiToUncompressedPublicKey(spkiBytes);
  const compressedPublicKey = compressPublicKey(uncompressedPublicKey);
  const hederaPublicKey = PublicKey.fromBytesECDSA(compressedPublicKey);

  const sign = async (message: Uint8Array): Promise<Uint8Array> => {
    // Hedera secp256k1 signatures are verified against keccak256(message).
    // KMS can't do keccak internally, so we provide the digest directly.
    const digest = Buffer.from(keccak_256(message));

    const response = await kms.send(
      new SignCommand({
        KeyId: normalizedKeyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256"
      })
    );

    if (!response.Signature) {
      throw new Error("KMS Sign did not return signature bytes");
    }

    return kmsDerSignatureToHederaRaw64(response.Signature);
  };

  return {
    keyId: normalizedKeyId,
    hederaPublicKey,
    uncompressedPublicKey,
    compressedPublicKey,
    sign
  };
}
