import assert from "node:assert/strict";
import { test } from "vitest";
import { PrivateKey } from "@hashgraph/sdk";
import { SigningKey, Transaction, computeAddress, getAddress, hashMessage, hexlify, keccak256, recoverAddress } from "ethers";
import {
  KmsEvmSigner,
  evmAddressFromUncompressedPublicKey,
  parseHederaEvmNetwork,
  resolveHederaEvmConnection,
} from "../evmClient";
import type { KmsHederaSigner } from "../kmsSigner";

function createLocalKmsSigner(privateKeyHex: string): KmsHederaSigner {
  const signingKey = new SigningKey(privateKeyHex);
  const uncompressedPublicKey = Buffer.from(SigningKey.computePublicKey(privateKeyHex, false).slice(2), "hex");
  const compressedPublicKey = Buffer.from(SigningKey.computePublicKey(privateKeyHex, true).slice(2), "hex");
  const hederaPublicKey = PrivateKey.fromStringECDSA(privateKeyHex.slice(2)).publicKey;

  const signDigest = async (digest: Uint8Array): Promise<Uint8Array> => {
    const signature = signingKey.sign(hexlify(digest));
    return Buffer.from(`${signature.r.slice(2)}${signature.s.slice(2)}`, "hex");
  };

  return {
    keyId: "kms-key-id",
    keyArn: "arn:aws:kms:us-east-1:123456789012:key/kms-key-id",
    hederaPublicKey,
    uncompressedPublicKey,
    compressedPublicKey,
    signDigest,
    sign: async (message: Uint8Array) => signDigest(Buffer.from(keccak256(message).slice(2), "hex")),
  };
}

test("parseHederaEvmNetwork and resolveHederaEvmConnection resolve defaults", () => {
  assert.equal(parseHederaEvmNetwork("testnet"), "testnet");
  assert.equal(parseHederaEvmNetwork("LOCALHOST"), "local");
  assert.throws(() => parseHederaEvmNetwork("invalid"), /Unsupported Hedera EVM network/);

  const local = resolveHederaEvmConnection({ network: "local" });
  assert.equal(local.network, "local");
  assert.equal(local.rpcUrl, "http://localhost:7546");
  assert.equal(local.chainId, 298);
});

test("evmAddressFromUncompressedPublicKey derives checksum address", () => {
  const privateKeyHex = "0x59c6995e998f97a5a0044966f0945382dca9f51f5f6a4e7f7f4f2f38f39b8f6f";
  const expectedAddress = getAddress(computeAddress(privateKeyHex));
  const uncompressed = Buffer.from(SigningKey.computePublicKey(privateKeyHex, false).slice(2), "hex");

  assert.equal(evmAddressFromUncompressedPublicKey(uncompressed), expectedAddress);
});

test("KmsEvmSigner signs messages and transactions recoverable to signer address", async () => {
  const privateKeyHex = "0x59c6995e998f97a5a0044966f0945382dca9f51f5f6a4e7f7f4f2f38f39b8f6f";
  const kmsSigner = createLocalKmsSigner(privateKeyHex);
  const signer = new KmsEvmSigner({ kmsSigner });

  const messageSignature = await signer.signMessage("hello-workit-evm");
  const recoveredMessageAddress = recoverAddress(hashMessage("hello-workit-evm"), messageSignature);
  assert.equal(getAddress(recoveredMessageAddress), await signer.getAddress());

  const rawTx = await signer.signTransaction({
    type: 2,
    chainId: 296,
    nonce: 0,
    to: "0x000000000000000000000000000000000000dEaD",
    gasLimit: 21_000,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 1n,
    data: "0x",
  });

  const parsed = Transaction.from(rawTx);
  assert.equal(getAddress(parsed.from ?? "0x0000000000000000000000000000000000000000"), await signer.getAddress());
});
