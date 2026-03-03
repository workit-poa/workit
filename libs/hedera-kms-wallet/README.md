# @workit/hedera-kms-wallet

Secure Hedera wallet abstraction backed by AWS KMS asymmetric keys (`ECC_SECG_P256K1`, `SIGN_VERIFY`).

Primary references used:
- Hedera: https://docs.hedera.com/hedera/core-concepts/accounts/account-properties
- Hedera AWS KMS guide: https://docs.hedera.com/hedera/sdks-and-apis/sdks/client#how-to-sign-a-transaction-with-aws-kms
- HIP-222 (ECDSA(secp256k1) transaction signatures): https://hips.hedera.com/hip/hip-222
- AWS KMS `GetPublicKey`: https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html
- AWS KMS + CloudTrail logging: https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html

## Architecture

Components:
- App backend (`libs/auth`) triggers provisioning + signing calls.
- AWS KMS stores and uses secp256k1 private keys for signing.
- Hedera SDK prepares/freeze/sign/submit transactions.
- Hedera Testnet/Mainnet receives signed transactions.

Data model mapping:
- `userId` -> `kmsKeyId`/`kmsKeyArn` -> `hederaAccountId` (+ public key fingerprint)

Trust boundaries:
- Client/UI never receives private key material.
- Backend runtime can only request `kms:Sign` and key metadata/public key reads.
- KMS boundary enforces non-exportability of private keys.
- New keys are created only with explicit least-privilege `policyBindings`.
- Existing/replacement key usage is verified against KMS tags (`app=workit`, `userId=<owner>`).

## Security Controls

### IAM least privilege

Use separate IAM roles:
- Key admin role: create/manage key lifecycle and aliases.
- Runtime signer role: sign and read public key metadata only.

Policy guidance is exposed by `kmsAccessPolicyGuidance()` in `src/kmsKeyManager.ts`.
Key creation is enforced with explicit key policy input via:
- `policyBindings` + `buildLeastPrivilegeKeyPolicy()`.

Custom `keyPolicy` overrides and `allowUnsafeDefaultKeyPolicy` bypasses are rejected.

Runtime role should allow only:
- `kms:Sign`
- `kms:GetPublicKey`
- `kms:DescribeKey`
- `kms:ListResourceTags`

Resource scope:
- Restrict to specific key ARN(s), never `*`.

### No private keys on client

- Private key generation and custody stays inside KMS.
- Signing uses KMS `Sign` API.
- Package converts returned DER signature to Hedera-compatible raw 64-byte `(r||s)` format.

### Audit logging / compliance

AWS CloudTrail logs KMS control-plane and cryptographic API calls.
Key events to filter in CloudTrail Event History:
- `CreateKey`
- `CreateAlias`
- `GetPublicKey`
- `Sign`
- `DescribeKey`

Fields to verify for audit evidence:
- `eventTime`
- `eventName`
- `userIdentity` (principal/role)
- `requestParameters.keyId`
- `sourceIPAddress`
- `awsRegion`

Package-level audit hook:
- Pass `auditLogger` to provisioning/key functions to emit structured operation events (`CreateKey`, `CreateAlias`, `DescribeKey`, `GetPublicKey`, `ListResourceTags`, `EnableKeyRotation`, `Sign`, `ProvisionAccount`, `RotateAccountKey`) into your SIEM/app logs.

## Bounty Requirement Mapping

- Secure key generation/storage/rotation:
  - `createUserKmsKey()` creates `ECC_SECG_P256K1` `SIGN_VERIFY` keys.
  - `rotateHederaAccountKmsKey()` performs managed rotation by creating/reusing a replacement KMS key and submitting Hedera `AccountUpdateTransaction`.
  - Asymmetric KMS auto-rotation limitation is handled by key replacement workflow rather than automatic in-place rotation.
- Submit a Hedera transaction:
  - `examples/hedera-kms-wallet-demo/src/kms-hedera-demo.ts` submits a topic message or tinybar transfer on testnet.
- Access controls + audit logging:
  - IAM policy templates via `kmsAccessPolicyGuidance()`.
  - Enforced create-time key policy requirements in `createUserKmsKey()`.
  - CloudTrail verification section above.
- Signing without private-key exposure:
  - `createKmsHederaSigner()` calls `kms:Sign`; only public key and signatures leave KMS.
- Working prototype + docs:
  - This package + `examples/hedera-kms-wallet-demo` + this README.

## How to Run Demo

Required environment variables:
- AWS:
  - `AWS_REGION`
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or attach IAM role)
  - `AWS_ACCOUNT_ID` (required when creating a new KMS key)
  - `KMS_KEY_ADMIN_PRINCIPAL_ARN` (required when creating a new KMS key)
  - `KMS_RUNTIME_SIGNER_PRINCIPAL_ARN` (required when creating a new KMS key)
- Hedera:
  - `HEDERA_NETWORK=testnet`
  - `OPERATOR_ID` and `OPERATOR_KEY` (also supports `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`)
- Optional:
  - `KMS_KEY_ID` (reuse existing key)
  - `HEDERA_USER_ACCOUNT_ID` (reuse existing account)
  - `DEMO_MODE=topic` (default) or `DEMO_MODE=transfer`
  - `HEDERA_NEW_ACCOUNT_INITIAL_HBAR=1` (required and must be `> 0` when provisioning a new demo account)

Environment file location for demo:
- Put env vars in `examples/hedera-kms-wallet-demo/.env` (preferred for this demo package)
- The demo also reads repo-root `../../.env` as fallback
- Start from `examples/hedera-kms-wallet-demo/.env.example`

Fail-fast behavior:
- Demo validates `DEMO_MODE` and `DEMO_TRANSFER_TINYBAR` before running.
- If provisioning a new account (missing `KMS_KEY_ID` or `HEDERA_USER_ACCOUNT_ID`), it fails early unless `HEDERA_NEW_ACCOUNT_INITIAL_HBAR > 0`.
- If provisioning a new account, it also fails early unless secure key policy bindings are provided (`AWS_ACCOUNT_ID`, `KMS_KEY_ADMIN_PRINCIPAL_ARN`, `KMS_RUNTIME_SIGNER_PRINCIPAL_ARN`).

Run:

```bash
pnpm demo:kms-hedera
```

or directly:

```bash
pnpm --filter @workit/hedera-kms-wallet-demo demo:kms-hedera
```

Expected output includes:
- KMS key id
- compressed public key
- Hedera account id
- transaction id
- receipt status
- mirror/hashscan link

## Testing

Run package tests (Vitest):

```bash
pnpm --filter @workit/hedera-kms-wallet test
```

Run coverage report:

```bash
pnpm --filter @workit/hedera-kms-wallet test:coverage
```

Environment file location for tests:
- Current unit tests are mocked and do not require env vars
- If you add env-dependent tests, use `libs/hedera-kms-wallet/.env.test`
- For machine-local secrets, use `libs/hedera-kms-wallet/.env.test.local` (gitignored)

## Publishing

Package is configured for npm publishing:
- entrypoints: `dist/index.js` + `dist/index.d.ts`
- export map in `package.json`
- published files restricted to `dist`, `README.md`, `.env.example`, and `LICENSE`
- `pnpm --filter @workit/hedera-kms-wallet prepack` runs clean + lint + tests + build

Pack and inspect:

```bash
pnpm --filter @workit/hedera-kms-wallet prepack
pnpm --filter @workit/hedera-kms-wallet pack
```

## Integration With Workit Auth

`libs/auth/src/wallet-provisioning.ts` should call `provisionHederaAccountForUser()` and persist:
- `kmsKeyId`
- `hederaAccountId`
- `hederaPublicKeyFingerprint`

For key rotation, call `rotateHederaAccountKmsKey()` and update persisted values:
- new `kmsKeyId`
- new `hederaPublicKeyFingerprint`
- old key lifecycle status (disabled/scheduled for deletion) per your operations policy

Security default:
- Runtime flows should pass an `existingKeyId` and keep `allowKeyCreation=false`.
- Admin provisioning flows can set `allowKeyCreation=true` with explicit `policyBindings`.

## Rotation Notes

AWS KMS automatic rotation is not currently supported for asymmetric secp256k1 signing keys.
This package provides `rotateHederaAccountKmsKey()` to execute the supported rotation workflow:
1. Create (or reuse) replacement KMS secp256k1 signing key.
2. Build `AccountUpdateTransaction` with the replacement public key.
3. Co-sign update using current key and replacement key.
4. Submit transaction and return new key metadata/fingerprint.
5. Persist new key mapping and retire old key per policy.

Minimal example:

```ts
import { rotateHederaAccountKmsKey } from "@workit/hedera-kms-wallet";

const rotated = await rotateHederaAccountKmsKey({
  userId: "user-123",
  accountId: "0.0.12345",
  currentKeyId: "old-kms-key-id",
  policyBindings: {
    accountId: process.env.AWS_ACCOUNT_ID!,
    keyAdminPrincipalArn: process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN!,
    runtimeSignerPrincipalArn: process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN!
  }
});
```

## Future Hardening

- Per-user provisioning rate limits and key quotas.
- Automated key disable/schedule-deletion workflows.
- Incident-response runbooks for compromised app credentials.
- Strong tenancy boundaries using per-tenant roles and tighter resource conditions.
- CloudTrail Lake alerts for suspicious signing patterns.
