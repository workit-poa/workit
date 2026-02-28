import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { compressPublicKey, derSigToRS, kmsDerSignatureToHederaRaw64, spkiToUncompressedPublicKey } from "./hederaKeyCodec";

test("spkiToUncompressedPublicKey + compressPublicKey produce expected lengths", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const spki = publicKey.export({ format: "der", type: "spki" });

  const uncompressed = spkiToUncompressedPublicKey(spki);
  const compressed = compressPublicKey(uncompressed);

  assert.equal(uncompressed.length, 65);
  assert.equal(uncompressed[0], 0x04);
  assert.equal(compressed.length, 33);
  assert.ok(compressed[0] === 0x02 || compressed[0] === 0x03);
});

test("DER ECDSA signature is parsed into 64-byte raw signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const message = Buffer.from("workit-kms-test");
  const derSignature = sign("sha256", message, privateKey);

  const { r, s } = derSigToRS(derSignature);
  assert.ok(r.length > 0 && r.length <= 32);
  assert.ok(s.length > 0 && s.length <= 32);

  const raw64 = kmsDerSignatureToHederaRaw64(derSignature);
  assert.equal(raw64.length, 64);

  // Sanity check public key parsing path is valid for this keypair.
  const spki = publicKey.export({ format: "der", type: "spki" });
  const uncompressed = spkiToUncompressedPublicKey(spki);
  assert.equal(uncompressed.length, 65);
});
