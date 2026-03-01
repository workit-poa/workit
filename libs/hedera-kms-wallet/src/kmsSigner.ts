import { SignCommand, KMSClient } from "@aws-sdk/client-kms";
import { PublicKey } from "@hashgraph/sdk";
import path from "node:path";
import { compressPublicKey, kmsDerSignatureToHederaRaw64, spkiToUncompressedPublicKey } from "./hederaKeyCodec";
import { getPublicKeyBytes } from "./kmsKeyManager";

type Keccak256Fn = (message: string) => string;
const sdkPackageJsonPath = require.resolve("@hashgraph/sdk/package.json");
const { keccak256 } = require(path.join(path.dirname(sdkPackageJsonPath), "lib/cryptography/keccak.cjs")) as {
  keccak256: Keccak256Fn;
};

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
    // Hedera secp256k1 signatures are verified against keccak256(message).
    // KMS can't do keccak internally, so we provide the digest directly.
    const digestHex = keccak256(`0x${Buffer.from(message).toString("hex")}`);
    const digest = Buffer.from(digestHex.slice(2), "hex");

    if (digest.length !== 32) {
      throw new Error(`Unexpected keccak256 digest length: ${digest.length}`);
    }

    const response = await kms.send(
      new SignCommand({
        KeyId: keyId,
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
    keyId,
    hederaPublicKey,
    uncompressedPublicKey,
    compressedPublicKey,
    sign
  };
}
