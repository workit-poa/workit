import { SignCommand, KMSClient } from "@aws-sdk/client-kms";
import { PublicKey } from "@hashgraph/sdk";
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
  const spkiBytes = await getPublicKeyBytes(kms, keyId);
  const uncompressedPublicKey = spkiToUncompressedPublicKey(spkiBytes);
  const compressedPublicKey = compressPublicKey(uncompressedPublicKey);
  const hederaPublicKey = PublicKey.fromBytesECDSA(compressedPublicKey);

  const sign = async (message: Uint8Array): Promise<Uint8Array> => {
    const response = await kms.send(
      new SignCommand({
        KeyId: keyId,
        Message: Buffer.from(message),
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256"
      })
    );

    if (!response.Signature) {
      throw new Error("KMS Sign did not return signature bytes");
    }

    return kmsDerSignatureToHederaRaw64(response.Signature);
  };

  return {
    keyId,
    hederaPublicKey,
    uncompressedPublicKey,
    compressedPublicKey,
    sign
  };
}
