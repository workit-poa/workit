import { createPublicKey } from "node:crypto";

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function leftPad32(bytes: Buffer): Buffer {
  if (bytes.length > 32) {
    throw new Error(`Expected <= 32 bytes but got ${bytes.length}`);
  }
  if (bytes.length === 32) {
    return bytes;
  }
  return Buffer.concat([Buffer.alloc(32 - bytes.length, 0), bytes]);
}

export function spkiToUncompressedPublicKey(spkiDerBytes: Uint8Array): Buffer {
  const keyObject = createPublicKey({
    key: Buffer.from(spkiDerBytes),
    format: "der",
    type: "spki"
  });
  const jwk = keyObject.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string };

  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || !jwk.x || !jwk.y) {
    throw new Error("Unexpected KMS key type. Expected secp256k1 EC key.");
  }

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");

  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid secp256k1 public key coordinates");
  }

  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

export function compressPublicKey(uncompressed: Uint8Array): Buffer {
  const key = Buffer.from(uncompressed);

  if (key.length !== 65 || key[0] !== 0x04) {
    throw new Error("Expected 65-byte uncompressed secp256k1 public key");
  }

  const x = key.subarray(1, 33);
  const y = key.subarray(33, 65);
  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03;

  return Buffer.concat([Buffer.from([prefix]), x]);
}

export function derSigToRS(der: Buffer): { r: Buffer; s: Buffer } {
  let offset = 0;

  const readByte = (): number => {
    const byte = der[offset];
    if (byte === undefined) {
      throw new Error("Invalid DER signature: unexpected end of buffer");
    }
    offset += 1;
    return byte;
  };

  const readLength = (): number => {
    const lengthByte = readByte();
    if ((lengthByte & 0x80) === 0) {
      return lengthByte;
    }

    const lengthOfLength = lengthByte & 0x7f;
    if (lengthOfLength === 0 || lengthOfLength > 2) {
      throw new Error("Invalid DER signature: unsupported length encoding");
    }

    let length = 0;
    for (let i = 0; i < lengthOfLength; i += 1) {
      length = (length << 8) | readByte();
    }
    return length;
  };

  const readInteger = (): Buffer => {
    const type = readByte();
    if (type !== 0x02) {
      throw new Error("Invalid DER signature: expected INTEGER");
    }

    const len = readLength();
    const value = der.subarray(offset, offset + len);
    if (value.length !== len) {
      throw new Error("Invalid DER signature: truncated INTEGER");
    }
    offset += len;

    // Trim optional sign byte if present.
    return value[0] === 0x00 ? value.subarray(1) : value;
  };

  const sequenceTag = readByte();
  if (sequenceTag !== 0x30) {
    throw new Error("Invalid DER signature: expected SEQUENCE");
  }

  const seqLen = readLength();
  const seqEnd = offset + seqLen;

  const r = readInteger();
  const s = readInteger();

  if (offset !== seqEnd) {
    throw new Error("Invalid DER signature: trailing bytes in sequence");
  }
  if (seqEnd !== der.length) {
    throw new Error("Invalid DER signature: trailing bytes after sequence");
  }

  return { r, s };
}

export function normalizeS(s: Buffer): Buffer {
  const sBigInt = BigInt(`0x${s.toString("hex") || "0"}`);
  const normalized = sBigInt > SECP256K1_HALF_N ? SECP256K1_N - sBigInt : sBigInt;
  const hex = normalized.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

export function rsToRaw64(r: Buffer, s: Buffer): Buffer {
  const normalizedR = leftPad32(r);
  const normalizedS = leftPad32(normalizeS(s));
  return Buffer.concat([normalizedR, normalizedS]);
}

export function kmsDerSignatureToHederaRaw64(derSignature: Uint8Array): Buffer {
  const { r, s } = derSigToRS(Buffer.from(derSignature));
  return rsToRaw64(r, s);
}
