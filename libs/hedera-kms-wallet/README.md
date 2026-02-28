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

## Security Controls

### IAM least privilege

Use separate IAM roles:
- Key admin role: create/manage key lifecycle and aliases.
- Runtime signer role: sign and read public key metadata only.

Policy guidance is exposed by `kmsAccessPolicyGuidance()` in `src/kmsKeyManager.ts`.

Runtime role should allow only:
- `kms:Sign`
- `kms:GetPublicKey`
- `kms:DescribeKey`

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

## Bounty Requirement Mapping

- Secure key generation/storage/rotation:
  - `createUserKmsKey()` creates `ECC_SECG_P256K1` `SIGN_VERIFY` keys.
  - Rotation control is attempted and documented; asymmetric auto-rotation limitation is captured with migration guidance.
- Submit a Hedera transaction:
  - `src/demo/kms-hedera-demo.ts` submits a topic message or tinybar transfer on testnet.
- Access controls + audit logging:
  - IAM policy templates via `kmsAccessPolicyGuidance()`.
  - CloudTrail verification section above.
- Signing without private-key exposure:
  - `createKmsHederaSigner()` calls `kms:Sign`; only public key and signatures leave KMS.
- Working prototype + docs:
  - This package + demo CLI + this README.

## How to Run Demo

Required environment variables:
- AWS:
  - `AWS_REGION`
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or attach IAM role)
- Hedera:
  - `HEDERA_NETWORK=testnet`
  - `OPERATOR_ID` and `OPERATOR_KEY` (also supports `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`)
- Optional:
  - `KMS_KEY_ID` (reuse existing key)
  - `HEDERA_USER_ACCOUNT_ID` (reuse existing account)
  - `DEMO_MODE=topic` (default) or `DEMO_MODE=transfer`

Run:

```bash
pnpm demo:kms-hedera
```

or directly:

```bash
pnpm --filter @workit/hedera-kms-wallet demo:kms-hedera
```

Expected output includes:
- KMS key id
- compressed public key
- Hedera account id
- transaction id
- receipt status
- mirror/hashscan link

## Integration With Workit Auth

`libs/auth/src/wallet-provisioning.ts` should call `provisionHederaAccountForUser()` and persist:
- `kmsKeyId`
- `hederaAccountId`
- `hederaPublicKeyFingerprint`

## Rotation Notes

AWS KMS automatic rotation is not currently supported for asymmetric secp256k1 signing keys.
Operational rotation pattern:
1. Create a new KMS secp256k1 key.
2. Derive new public key.
3. Submit Hedera `AccountUpdateTransaction` to rotate account key.
4. Update DB mapping to new `kmsKeyId` and fingerprint.
5. Retire old key per policy.

## Future Hardening

- Per-user provisioning rate limits and key quotas.
- Automated key disable/schedule-deletion workflows.
- Incident-response runbooks for compromised app credentials.
- Strong tenancy boundaries using per-tenant roles and tighter resource conditions.
- CloudTrail Lake alerts for suspicious signing patterns.
