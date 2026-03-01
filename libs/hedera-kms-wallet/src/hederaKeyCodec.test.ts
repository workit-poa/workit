import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compressPublicKey,
  derSigToRS,
  kmsDerSignatureToHederaRaw64,
  normalizeS,
  rsToRaw64,
  spkiToUncompressedPublicKey
} from "./hederaKeyCodec";

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function bigIntToBuffer(value: bigint): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
}

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

test("spkiToUncompressedPublicKey rejects non-secp256k1 keys", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ format: "der", type: "spki" });

  assert.throws(
    () => spkiToUncompressedPublicKey(spki),
    /Unexpected KMS key type\. Expected secp256k1 EC key\./
  );
});

test("compressPublicKey validates uncompressed key format", () => {
  assert.throws(() => compressPublicKey(Buffer.alloc(64)), /Expected 65-byte uncompressed secp256k1 public key/);
  assert.throws(
    () => compressPublicKey(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64)])),
    /Expected 65-byte uncompressed secp256k1 public key/
  );
});

test("derSigToRS parses short and long-form DER lengths", () => {
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

  const longLen1 = Buffer.from("308106020101020101", "hex");
  const parsedLongLen1 = derSigToRS(longLen1);
  assert.equal(parsedLongLen1.r.toString("hex"), "01");
  assert.equal(parsedLongLen1.s.toString("hex"), "01");

  const longLen2 = Buffer.from("30820006020101020101", "hex");
  const parsedLongLen2 = derSigToRS(longLen2);
  assert.equal(parsedLongLen2.r.toString("hex"), "01");
  assert.equal(parsedLongLen2.s.toString("hex"), "01");
});

test("derSigToRS rejects malformed DER signatures", () => {
  assert.throws(() => derSigToRS(Buffer.alloc(0)), /unexpected end of buffer/);
  assert.throws(() => derSigToRS(Buffer.from("3106020101020101", "hex")), /expected SEQUENCE/);
  assert.throws(
    () => derSigToRS(Buffer.from("3083000006020101020101", "hex")),
    /unsupported length encoding/
  );
  assert.throws(() => derSigToRS(Buffer.from("3006020101", "hex")), /truncated SEQUENCE/);
  assert.throws(() => derSigToRS(Buffer.from("3006020101030101", "hex")), /expected INTEGER/);
  assert.throws(() => derSigToRS(Buffer.from("3003020201", "hex")), /truncated INTEGER/);
  assert.throws(() => derSigToRS(Buffer.from("30050200020101", "hex")), /empty INTEGER/);
  assert.throws(() => derSigToRS(Buffer.from("3006020180020101", "hex")), /negative INTEGER/);
  assert.throws(
    () => derSigToRS(Buffer.from("300702020001020101", "hex")),
    /non-canonical INTEGER encoding/
  );
  assert.throws(() => derSigToRS(Buffer.from("3005020101020101", "hex")), /trailing bytes in sequence/);
  assert.throws(() => derSigToRS(Buffer.from("300602010102010100", "hex")), /after sequence/);
});

test("normalizeS and rsToRaw64 normalize high-S signatures", () => {
  const normalizedLow = normalizeS(Buffer.from("02", "hex"));
  assert.equal(normalizedLow.length, 32);
  assert.equal(normalizedLow.at(-1), 0x02);

  const highS = bigIntToBuffer(SECP256K1_N - 1n);
  const normalizedHigh = normalizeS(highS);
  assert.equal(normalizedHigh.length, 32);
  assert.equal(normalizedHigh.toString("hex"), `${"0".repeat(63)}1`);

  const raw64 = rsToRaw64(Buffer.from("01", "hex"), highS);
  assert.equal(raw64.length, 64);
  assert.equal(raw64.subarray(0, 32).toString("hex"), `${"0".repeat(63)}1`);
  assert.equal(raw64.subarray(32).toString("hex"), `${"0".repeat(63)}1`);
});

test("normalizeS and rsToRaw64 reject invalid scalars", () => {
  assert.throws(() => normalizeS(Buffer.alloc(0)), /Invalid s scalar length/);
  assert.throws(() => normalizeS(Buffer.alloc(32, 0)), /Invalid s scalar range/);
  assert.throws(() => normalizeS(bigIntToBuffer(SECP256K1_N)), /Invalid s scalar range/);

  assert.throws(() => rsToRaw64(Buffer.alloc(0), Buffer.from("01", "hex")), /Invalid r scalar length/);
  assert.throws(() => rsToRaw64(Buffer.alloc(33, 1), Buffer.from("01", "hex")), /Invalid r scalar length/);
  assert.throws(
    () => rsToRaw64(Buffer.from("01", "hex"), bigIntToBuffer(SECP256K1_N)),
    /Invalid s scalar range/
  );
});
