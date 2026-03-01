import { createPublicKey } from "node:crypto";

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function leftPad32(bytes: Buffer): Buffer {
  if (bytes.length === 32) {
    return bytes;
  }
  return Buffer.concat([Buffer.alloc(32 - bytes.length, 0), bytes]);
}

function bigIntToBuffer(value: bigint): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
}

function parseScalar(bytes: Buffer, fieldName: "r" | "s"): bigint {
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(`Invalid ${fieldName} scalar length: ${bytes.length}`);
  }

  const value = BigInt(`0x${bytes.toString("hex")}`);
  if (value <= 0n || value >= SECP256K1_N) {
    throw new Error(`Invalid ${fieldName} scalar range`);
  }

  return value;
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
    if (len === 0) {
      throw new Error("Invalid DER signature: empty INTEGER");
    }

    const value = der.subarray(offset, offset + len);
    if (value.length !== len) {
      throw new Error("Invalid DER signature: truncated INTEGER");
    }
    offset += len;

    if ((value[0] & 0x80) !== 0) {
      throw new Error("Invalid DER signature: negative INTEGER");
    }
    if (value.length > 1 && value[0] === 0x00 && (value[1] & 0x80) === 0) {
      throw new Error("Invalid DER signature: non-canonical INTEGER encoding");
    }

    // Trim optional sign byte if present.
    return value[0] === 0x00 ? value.subarray(1) : value;
  };

  const sequenceTag = readByte();
  if (sequenceTag !== 0x30) {
    throw new Error("Invalid DER signature: expected SEQUENCE");
  }

  const seqLen = readLength();
  const seqEnd = offset + seqLen;
  if (seqEnd > der.length) {
    throw new Error("Invalid DER signature: truncated SEQUENCE");
  }

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
  const sBigInt = parseScalar(s, "s");
  const normalized = sBigInt > SECP256K1_HALF_N ? SECP256K1_N - sBigInt : sBigInt;
  return leftPad32(bigIntToBuffer(normalized));
}

export function rsToRaw64(r: Buffer, s: Buffer): Buffer {
  const normalizedR = leftPad32(bigIntToBuffer(parseScalar(r, "r")));
  const normalizedS = normalizeS(s);
  return Buffer.concat([normalizedR, normalizedS]);
}

export function kmsDerSignatureToHederaRaw64(derSignature: Uint8Array): Buffer {
  const { r, s } = derSigToRS(Buffer.from(derSignature));
  return rsToRaw64(r, s);
}
