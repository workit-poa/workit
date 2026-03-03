# @workit-poa/hedera-kms-wallet

AWS KMS-backed Hedera wallet utilities for secure key management, account provisioning, transaction signing, and key rotation.

This package is designed for backend services that want to:
- keep private keys non-exportable inside AWS KMS,
- use secp256k1 signatures for Hedera transactions,
- enforce explicit key ownership and least-privilege IAM boundaries,
- support audited provisioning and controlled key rotation.

## Table of Contents
- [What This Package Solves](#what-this-package-solves)
- [Features](#features)
- [Requirements](#requirements)
- [Requirement Coverage Matrix](#requirement-coverage-matrix)
- [Installation](#installation)
- [Architecture and Trust Boundaries](#architecture-and-trust-boundaries)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [Usage Guide](#usage-guide)
- [IAM and Key Policy Guidance](#iam-and-key-policy-guidance)
- [Audit and Compliance Logging](#audit-and-compliance-logging)
- [Run the Demo](#run-the-demo)
- [Testing](#testing)
- [API Reference](#api-reference)
- [Publishing](#publishing)
- [Troubleshooting](#troubleshooting)
- [References](#references)
- [License](#license)

## What This Package Solves

Hedera transactions need signatures from account keys. This library lets you:
- generate and store secp256k1 keys in AWS KMS (`ECC_SECG_P256K1`, `SIGN_VERIFY`),
- derive Hedera-compatible public keys from KMS public key material,
- sign Hedera transaction bytes without exporting private keys,
- provision new Hedera accounts tied to KMS keys,
- rotate account keys with explicit dual-signature account updates.

## Features

- KMS key management for user wallets:
  - create user-tagged keys with aliases,
  - validate key type and enabled state,
  - assert key ownership via required tags (`app`, `userId`).
- Hedera signing and transaction helpers:
  - convert KMS DER ECDSA signatures into Hedera raw 64-byte `(r||s)` signatures,
  - submit topic message and tinybar transfer transactions.
- Account lifecycle:
  - provision Hedera account from existing or newly-created KMS key,
  - rotate account key by co-signing with current and replacement keys.
- Security and operations:
  - enforced least-privilege key policy bindings for key creation,
  - structured audit hook for provisioning/key/signing events.

## Requirements

- Node.js `>=18`
- AWS account with KMS permissions for your runtime/admin roles
- Hedera operator account (`OPERATOR_ID` + `OPERATOR_KEY` or `HEDERA_OPERATOR_*`)
- Package manager: `pnpm` (repo standard), `npm`, or `yarn`

## Requirement Coverage Matrix

This section maps project requirements to implementation and documentation artifacts.

### 1) Secure key management solution with compliance and auditability

- Key lifecycle is implemented in `kmsKeyManager` and `walletProvisioning`.
- Least-privilege key policy generation is enforced using `policyBindings`.
- Structured audit events are emitted via `auditLogger` for key and signing operations.
- CloudTrail verification guidance is documented in [Audit and Compliance Logging](#audit-and-compliance-logging).

Code references:
- [`src/kmsKeyManager.ts`](./src/kmsKeyManager.ts)
- [`src/walletProvisioning.ts`](./src/walletProvisioning.ts)

### 2) Use AWS KMS for secure key generation, storage, and rotation

- Key generation: `createUserKmsKey()` creates `ECC_SECG_P256K1` + `SIGN_VERIFY` keys.
- Key storage/security: private keys are KMS-managed and never exported.
- Key rotation: `rotateHederaAccountKmsKey()` performs managed replacement + Hedera account key update.
- Automatic in-place rotation limits for asymmetric keys are documented with mitigation workflow.

Code references:
- [`src/kmsKeyManager.ts`](./src/kmsKeyManager.ts)
- [`src/walletProvisioning.ts`](./src/walletProvisioning.ts)

### 3) Submit a transaction on Hedera

- Transaction helpers:
  - `submitTopicMessageWithKmsSignature()`
  - `submitTinybarTransferWithKmsSignature()`
- End-to-end demo transaction flow is implemented in:
  - `examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts`

Code references:
- [`src/hederaClient.ts`](./src/hederaClient.ts)
- [`examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts`](../../examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts)

### 4) Implement proper access controls and audit logging

- Access control:
  - `buildLeastPrivilegeKeyPolicy()`
  - `kmsAccessPolicyGuidance()`
  - ownership enforcement with `assertKmsKeyOwnershipForUser()`
- Audit:
  - structured `auditLogger` hook across key/sign/provision/rotation operations
  - CloudTrail event and field guidance documented

Code references:
- [`src/kmsKeyManager.ts`](./src/kmsKeyManager.ts)
- [`src/kmsSigner.ts`](./src/kmsSigner.ts)
- [`src/walletProvisioning.ts`](./src/walletProvisioning.ts)

### 5) Demonstrate secure transaction signing without exposing private keys

- `createKmsHederaSigner()` uses KMS `Sign` API with digest mode.
- Private keys remain in KMS; only signature/public key material is handled by application code.
- DER ECDSA signatures are canonicalized into Hedera raw 64-byte format.

Code references:
- [`src/kmsSigner.ts`](./src/kmsSigner.ts)
- [`src/hederaKeyCodec.ts`](./src/hederaKeyCodec.ts)

### 6) Working prototype + documentation for architecture, security controls, and Hedera integration

- Working prototype:
  - standalone demo app in `examples/hedera-kms-wallet-demo`
  - integrated app prototype in `apps/web` auth flow (`NextAuth` + OTP/OAuth + managed wallet provisioning)
  - runnable command for standalone flow: `pnpm demo:kms-hedera`
- Documentation:
  - architecture and trust boundaries
  - IAM and key policy guidance
  - audit/compliance logging
  - integration and usage examples for Hedera transactions

Code and doc references:
- [`examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts`](../../examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts)
- [`apps/web/lib/next-auth-options.ts`](../../apps/web/lib/next-auth-options.ts)
- [`libs/auth/src/auth.service.ts`](../auth/src/auth.service.ts)
- [`libs/auth/src/wallet-provisioning.ts`](../auth/src/wallet-provisioning.ts)
- [`docs/authentication.md`](../../docs/authentication.md)
- [Architecture and Trust Boundaries](#architecture-and-trust-boundaries)
- [IAM and Key Policy Guidance](#iam-and-key-policy-guidance)
- [Audit and Compliance Logging](#audit-and-compliance-logging)
- [Run the Demo](#run-the-demo)

> Screenshot placeholder: Compliance checklist screenshot showing each requirement mapped to a README section and source file.

## Installation

### From npm

```bash
pnpm add @workit-poa/hedera-kms-wallet
```

or:

```bash
npm install @workit-poa/hedera-kms-wallet
```

### In This Monorepo

Install workspace dependencies from repository root:

```bash
pnpm install
```

## Architecture and Trust Boundaries

### Components

- Your backend calls this package for provisioning/signing operations.
- AWS KMS stores and signs with non-exportable private keys.
- Hedera SDK freezes, signs, submits, and resolves transaction receipts.
- Hedera testnet/mainnet receives signed transactions.

### Identity mapping

`userId` -> `kmsKeyId`/`kmsKeyArn` -> `hederaAccountId` (+ public key fingerprint)

### Trust boundaries

- Private key material never leaves KMS.
- Runtime role is scoped to signing + metadata reads.
- Key creation is guarded by explicit policy bindings.
- Existing/replacement keys are tag-validated before use.

> Screenshot placeholder: Architecture diagram showing backend -> AWS KMS -> Hedera network, with private key boundary around KMS.

## Configuration

Copy [`.env.example`](./.env.example) and fill values for your environment.

### Core environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `AWS_REGION` | Yes | AWS region for KMS client |
| `OPERATOR_ID` or `HEDERA_OPERATOR_ID` | Yes | Hedera operator account ID used to submit transactions |
| `OPERATOR_KEY` or `HEDERA_OPERATOR_KEY` | Yes | Hedera operator private key |
| `HEDERA_NETWORK` | No | `testnet` (default) or `mainnet` |
| `OPERATOR_KEY_TYPE` | No | Force parsing mode: `ecdsa`, `secp256k1`, `ed25519`, or `der` |
| `HEDERA_KMS_ALIAS_PREFIX` | No | Default alias prefix when creating keys (default: `alias/workit-user`) |
| `HEDERA_KMS_KEY_DESCRIPTION_PREFIX` | No | Default key description prefix |

### Variables required for secure key creation

These are required when your flow allows creating new KMS keys:

| Variable | Required when creating keys | Description |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | Yes | 12-digit AWS account ID |
| `KMS_KEY_ADMIN_PRINCIPAL_ARN` | Yes | IAM principal ARN for key administration |
| `KMS_RUNTIME_SIGNER_PRINCIPAL_ARN` | Yes | IAM principal ARN for runtime signing role |

## Quick Start

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import {
  createHederaClient,
  createKmsHederaSigner,
  submitTopicMessageWithKmsSignature
} from "@workit-poa/hedera-kms-wallet";

const kms = new KMSClient({ region: process.env.AWS_REGION });

const signer = await createKmsHederaSigner({
  kms,
  keyId: process.env.KMS_KEY_ID!
});

const client = createHederaClient({
  network: (process.env.HEDERA_NETWORK as "testnet" | "mainnet") || "testnet",
  operatorId: process.env.OPERATOR_ID!,
  operatorKey: process.env.OPERATOR_KEY!
});

const result = await submitTopicMessageWithKmsSignature({
  client,
  signer,
  payerAccountId: "0.0.12345",
  message: "hello from KMS signer"
});

console.log(result.transactionId, result.receiptStatus, result.mirrorLink);

kms.destroy();
client.close();
```

## Usage Guide

### 1) Create a KMS-backed signer

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import { createKmsHederaSigner } from "@workit-poa/hedera-kms-wallet";

const kms = new KMSClient({ region: "us-east-1" });

const signer = await createKmsHederaSigner({
  kms,
  keyId: "your-kms-key-id-or-arn",
  auditLogger: event => console.log(event)
});
```

### 2) Provision a Hedera account for a user

Runtime-safe mode (recommended): use pre-created key.

```ts
import { provisionHederaAccountForUser } from "@workit-poa/hedera-kms-wallet";

const provisioned = await provisionHederaAccountForUser({
  userId: "user-123",
  existingKeyId: "kms-key-id",
  awsRegion: process.env.AWS_REGION,
  operatorId: process.env.OPERATOR_ID,
  operatorKey: process.env.OPERATOR_KEY
});
```

Admin mode: allow secure key creation.

```ts
const provisioned = await provisionHederaAccountForUser({
  userId: "user-123",
  allowKeyCreation: true,
  initialHbar: 1,
  policyBindings: {
    accountId: process.env.AWS_ACCOUNT_ID!,
    keyAdminPrincipalArn: process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN!,
    runtimeSignerPrincipalArn: process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN!
  }
});
```

### 3) Submit a tinybar transfer

```ts
import { submitTinybarTransferWithKmsSignature } from "@workit-poa/hedera-kms-wallet";

const transfer = await submitTinybarTransferWithKmsSignature({
  client,
  signer,
  fromAccountId: "0.0.123",
  toAccountId: "0.0.456",
  payerAccountId: "0.0.123",
  amountTinybar: 10
});
```

`payerAccountId` lets you charge network fees to the KMS-managed wallet account instead of the operator account.

### 4) Rotate Hedera account key

AWS asymmetric secp256k1 keys do not support in-place automatic rotation. Use managed replacement:

```ts
import { rotateHederaAccountKmsKey } from "@workit-poa/hedera-kms-wallet";

const rotated = await rotateHederaAccountKmsKey({
  userId: "user-123",
  accountId: "0.0.12345",
  currentKeyId: "current-kms-key-id",
  policyBindings: {
    accountId: process.env.AWS_ACCOUNT_ID!,
    keyAdminPrincipalArn: process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN!,
    runtimeSignerPrincipalArn: process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN!
  }
});
```

Rotation flow:
1. Create or reuse replacement key.
2. Verify ownership tags for current + replacement keys.
3. Build `AccountUpdateTransaction` with replacement public key.
4. Co-sign with current and replacement keys.
5. Submit transaction and persist new key details.

> Screenshot placeholder: Console output showing successful key rotation with previous/new key fingerprints and transaction ID.

## IAM and Key Policy Guidance

Use separate IAM responsibilities:
- Key admin role: create/manage key lifecycle and aliases.
- Runtime signer role: sign and read key metadata/public key.

Helpers:
- `buildLeastPrivilegeKeyPolicy(bindings)`
- `kmsAccessPolicyGuidance(keyArn?, aliasArn?)`

Enforced safeguards:
- `keyPolicy` overrides are intentionally rejected.
- `allowUnsafeDefaultKeyPolicy` bypass is intentionally rejected.
- `policyBindings` is required whenever a new key is created.

Recommended runtime permissions:
- `kms:Sign`
- `kms:GetPublicKey`
- `kms:DescribeKey`
- `kms:ListResourceTags`

Scope runtime policies to explicit key ARNs whenever possible.

## Audit and Compliance Logging

Pass `auditLogger` to emit structured events for:
- `CreateKey`
- `CreateAlias`
- `EnableKeyRotation`
- `DescribeKey`
- `GetPublicKey`
- `ListResourceTags`
- `Sign`
- `ProvisionAccount`
- `RotateAccountKey`

CloudTrail should also record KMS API calls. Useful fields for audit evidence:
- `eventTime`
- `eventName`
- `userIdentity`
- `requestParameters.keyId`
- `sourceIPAddress`
- `awsRegion`

> Screenshot placeholder: CloudTrail event history filtered to `Sign` and `CreateKey` for the relevant KMS key ARN.

## Run the Demo

Demo source:
- [`examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts`](../../examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts)

### 1) Configure demo env

```bash
cp examples/hedera-kms-wallet-demo/.env.example examples/hedera-kms-wallet-demo/.env
```

The demo loads:
1. `examples/hedera-kms-wallet-demo/.env`
2. repo root `.env` as fallback

### 2) Choose demo mode

- `DEMO_MODE=topic` (default): creates topic + submits message
- `DEMO_MODE=transfer`: submits tinybar transfer

Validation behavior:
- `DEMO_TRANSFER_TINYBAR` must be a positive safe integer.
- If provisioning a new account, `HEDERA_NEW_ACCOUNT_INITIAL_HBAR` must be `> 0`.
- If creating a new KMS key, key policy bindings env vars are mandatory.

### 3) Run

From repo root:

```bash
pnpm demo:kms-hedera
```

or:

```bash
pnpm --filter @workit-poa/hedera-kms-wallet-demo demo:kms-hedera
```

Expected output includes:
- key/account details,
- transaction ID + receipt status,
- Hashscan transaction link.

Note: the demo now sets `payerAccountId` to the managed wallet account, so transaction fees are charged to the KMS-backed wallet account (not the operator).

> Screenshot placeholder: Terminal output from successful `DEMO_MODE=topic` run including topic ID and Hashscan URL.
> Screenshot placeholder: Hashscan transaction page confirming SUCCESS status.

## Testing

Run package tests:

```bash
pnpm --filter @workit-poa/hedera-kms-wallet test
```

Run coverage:

```bash
pnpm --filter @workit-poa/hedera-kms-wallet test:coverage
```

What is covered:
- key creation/validation/tag ownership checks,
- DER-to-raw signature conversion and low-S normalization,
- signer behavior and audit logging,
- Hedera client and transaction helper behavior,
- provisioning and rotation happy paths + validation failures.

Test env loading:
- `libs/hedera-kms-wallet/.env.test`
- `libs/hedera-kms-wallet/.env.test.local` (local override)

Current tests are mock-driven and do not require live AWS/Hedera credentials.

## API Reference

All exports are re-exported from [`src/index.ts`](./src/index.ts).

### Key management (`kmsKeyManager`)

- `createUserKmsKey(params)`
- `validateKmsSecp256k1SigningKey(kms, keyId, auditLogger?)`
- `getPublicKeyBytes(kms, keyId, auditLogger?)`
- `assertKmsKeyOwnershipForUser({ kms, keyId, userId, expectedAppTag?, auditLogger? })`
- `buildLeastPrivilegeKeyPolicy(bindings)`
- `kmsAccessPolicyGuidance(keyArn?, aliasArn?)`

### Signer (`kmsSigner`)

- `createKmsHederaSigner({ kms, keyId, auditLogger? })`
- Returns `KmsHederaSigner`:
  - `keyId`, `keyArn`
  - `hederaPublicKey`
  - `compressedPublicKey`, `uncompressedPublicKey`
  - `sign(message)`

### Hedera helpers (`hederaClient`)

- `createHederaClient({ network?, operatorId, operatorKey })`
- `createHederaClientFromEnv()`
- `addKmsSignatureToFrozenTransaction(transaction, signer)`
- `executeSignedTransaction(client, transaction)`
- `submitTopicMessageWithKmsSignature({ client, signer, message, topicMemo?, payerAccountId?, network? })`
- `submitTinybarTransferWithKmsSignature({ client, signer, fromAccountId, toAccountId, amountTinybar, payerAccountId?, network? })`
- `mirrorLinkForTransaction(network, transactionId)`
- `getWalletDetails(accountId, network?)`

### Wallet lifecycle (`walletProvisioning`)

- `provisionHederaAccountForUser(params)`
- `rotateHederaAccountKmsKey(params)`

## Publishing

Pack/publish checks:

```bash
pnpm --filter @workit-poa/hedera-kms-wallet prepack
pnpm --filter @workit-poa/hedera-kms-wallet pack
```

`prepack` runs:
1. `clean`
2. `lint`
3. `test`
4. `build`

Published files are restricted to:
- `dist`
- `README.md`
- `.env.example`
- `LICENSE`

## Troubleshooting

- `Missing AWS_REGION`
  - Set `AWS_REGION` (or pass `awsRegion` explicitly where supported).
- `Missing operator credentials`
  - Set `OPERATOR_ID` + `OPERATOR_KEY` (or `HEDERA_OPERATOR_*` alternatives).
- `existingKeyId is required unless allowKeyCreation=true`
  - Runtime path expects pre-provisioned keys.
- `policyBindings is required when creating a new key`
  - Provide `AWS_ACCOUNT_ID`, admin signer principal ARNs, and pass `policyBindings`.
- `KMS key ... must use KeySpec ECC_SECG_P256K1`
  - Use secp256k1 signing keys only.
- `Signer must return a 64-byte (r||s) secp256k1 signature`
  - Ensure signatures come from this package’s signer or equivalent canonical formatter.

## References

- Hedera account model: https://docs.hedera.com/hedera/core-concepts/accounts/account-properties
- Hedera SDK and KMS signing guidance: https://docs.hedera.com/hedera/sdks-and-apis/sdks/client#how-to-sign-a-transaction-with-aws-kms
- HIP-222 (ECDSA secp256k1 transaction signatures): https://hips.hedera.com/hip/hip-222
- AWS KMS `GetPublicKey`: https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html
- AWS KMS + CloudTrail: https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html

## License

MIT
