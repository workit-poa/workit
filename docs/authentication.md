# Authentication and Authorization

## Identity Model

Unified `users` table (Drizzle schema `users`) supports:

- Email identity (`email`)
- OAuth provider IDs (`google_id`, `twitter_id` for X, `discord_id`)
- Hedera linkage (`hedera_account_id`, `kms_key_id`, `hedera_public_key_fingerprint`)

Every account uses one internal UUID (`id`).

## Session Model

Session and cookies are handled by NextAuth (`/api/auth/[...nextauth]`) using JWT session strategy.
`AuthProvider` in the web app reads NextAuth session state client-side.
Email OTP challenges are stored in `email_otp_challenges` with hashed codes, attempt limits, and expiration.

## Security Controls

- Rate limiting: in-memory per-IP limit on auth endpoints
- Secrets in env vars (`NEXTAUTH_SECRET`, OAuth client secrets)

## Wallet Provisioning (AWS KMS + Hedera)

- On new user creation (email signup or first-time OAuth), backend provisions a managed wallet via `@workit/hedera-kms-wallet`.
- A dedicated AWS KMS asymmetric key is created per user (`ECC_SECG_P256K1`, `SIGN_VERIFY`).
- Hedera account is created with the derived ECDSA(secp256k1) public key.
- Persisted on `users`: `hedera_account_id`, `kms_key_id` (ARN/KeyId), and `hedera_public_key_fingerprint`.
- Private keys never leave AWS KMS; signing is performed through `kms:Sign`.

Required environment variables:

- `AWS_REGION`
- `HEDERA_NETWORK` (`testnet` or `mainnet`)
- `OPERATOR_ID` / `OPERATOR_KEY` (or backward-compatible `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`)
- `HEDERA_NEW_ACCOUNT_INITIAL_HBAR` (default `1`)
- `HEDERA_KMS_CREATE_ALIAS` (default `true`)
- `HEDERA_KMS_ALIAS_PREFIX` (default `alias/workit-user`)
- `HEDERA_KMS_KEY_DESCRIPTION_PREFIX`

Runtime dependencies required in deployment:

- `@aws-sdk/client-kms`
- `@hashgraph/sdk`

Note: AWS automatic rotation is not available for asymmetric KMS keys (`ECC_SECG_P256K1`), so rotation requires explicit key replacement plus Hedera `AccountUpdate` key migration.

## OAuth Notes

- OAuth providers are handled by NextAuth providers:
  - Google
  - X (custom OIDC provider with PKCE/state)
  - Discord
- On successful OAuth callback, NextAuth callback maps provider identity to internal user via `authenticateWithOAuth`.
- Required env vars include:
  - `NEXTAUTH_SECRET`
  - `NEXTAUTH_URL`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `X_CLIENT_ID`, `X_CLIENT_SECRET`
  - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
