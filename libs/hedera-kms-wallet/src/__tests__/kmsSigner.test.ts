import { generateKeyPairSync, sign as signWithKey } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "vitest";
import { DescribeKeyCommand, GetPublicKeyCommand, SignCommand, type KMSClient } from "@aws-sdk/client-kms";
import { createKmsHederaSigner } from "../kmsSigner";

function fakeKms(send: (command: unknown) => Promise<unknown>): KMSClient {
  return { send } as unknown as KMSClient;
}

test("createKmsHederaSigner derives Hedera key and signs with KMS digest mode", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const spkiBytes = publicKey.export({ format: "der", type: "spki" });
  const derSignature = signWithKey("sha256", Buffer.from("kms-signer-test"), privateKey);
  const auditEvents: Array<{ operation: string; status: string }> = [];

  const commands: unknown[] = [];
  const kms = fakeKms(async command => {
    commands.push(command);

    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: spkiBytes };
    }
    if (command instanceof SignCommand) {
      assert.equal(command.input.KeyId, "key-id");
      assert.equal(command.input.MessageType, "DIGEST");
      assert.equal(command.input.SigningAlgorithm, "ECDSA_SHA_256");
      assert.equal((command.input.Message as Uint8Array).length, 32);
      return { Signature: derSignature };
    }

    throw new Error("Unexpected command");
  });

  const signer = await createKmsHederaSigner({
    kms,
    keyId: "  key-id  ",
    auditLogger: event => auditEvents.push({ operation: event.operation, status: event.status })
  });
  assert.equal(signer.keyId, "key-id");
  assert.equal(signer.keyArn, "arn:aws:kms:us-east-1:123456789012:key/key-id");
  assert.equal(signer.uncompressedPublicKey.length, 65);
  assert.equal(signer.compressedPublicKey.length, 33);

  const signature = await signer.sign(Buffer.from("hello-workit"));
  assert.equal(signature.length, 64);
  assert.equal(commands.length, 3);
  assert.equal(
    auditEvents.some(event => event.operation === "DescribeKey" && event.status === "success"),
    true
  );
  assert.equal(
    auditEvents.some(event => event.operation === "GetPublicKey" && event.status === "success"),
    true
  );
  assert.equal(auditEvents.some(event => event.operation === "Sign" && event.status === "success"), true);
});

test("createKmsHederaSigner validates keyId and key shape", async () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaSpki = publicKey.export({ format: "der", type: "spki" });

  const kms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: rsaSpki };
    }
    throw new Error("Unexpected command");
  });

  await assert.rejects(() => createKmsHederaSigner({ kms, keyId: "   " }), /keyId is required/);
  await assert.rejects(() => createKmsHederaSigner({ kms, keyId: "key-id" }), /Expected secp256k1 EC key/);
});

test("sign throws when KMS does not return a signature", async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const spkiBytes = publicKey.export({ format: "der", type: "spki" });
  const auditEvents: Array<{ operation: string; status: string; detail?: string }> = [];

  const kms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: spkiBytes };
    }
    if (command instanceof SignCommand) {
      return {};
    }
    throw new Error("Unexpected command");
  });

  const signer = await createKmsHederaSigner({
    kms,
    keyId: "key-id",
    auditLogger: event => auditEvents.push({ operation: event.operation, status: event.status, detail: event.detail })
  });
  await assert.rejects(() => signer.sign(Buffer.from("hello")), /did not return signature bytes/);
  assert.equal(auditEvents.some(event => event.operation === "Sign" && event.status === "failure"), true);
  assert.equal(
    auditEvents.some(
      event => event.operation === "Sign" && event.status === "failure" && event.detail === "KMS Sign did not return signature bytes"
    ),
    true
  );
});

test("sign emits failure audit when KMS Sign command fails", async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const spkiBytes = publicKey.export({ format: "der", type: "spki" });
  const auditEvents: Array<{ operation: string; status: string; detail?: string }> = [];

  const kms = fakeKms(async command => {
    if (command instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: "key-id",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/key-id",
          Enabled: true,
          KeyState: "Enabled",
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY"
        }
      };
    }
    if (command instanceof GetPublicKeyCommand) {
      return { PublicKey: spkiBytes };
    }
    if (command instanceof SignCommand) {
      throw new Error("KMS unavailable");
    }
    throw new Error("Unexpected command");
  });

  const signer = await createKmsHederaSigner({
    kms,
    keyId: "key-id",
    auditLogger: event => auditEvents.push({ operation: event.operation, status: event.status, detail: event.detail })
  });

  await assert.rejects(() => signer.sign(Buffer.from("hello")), /KMS unavailable/);
  assert.equal(
    auditEvents.some(event => event.operation === "Sign" && event.status === "failure" && /KMS unavailable/.test(event.detail ?? "")),
    true
  );
});
