# Authentication and Authorization

## Identity Model

Unified `users` table (Drizzle schema `users`) supports:

- Email/password (`email`, `password_hash`)
- OAuth provider IDs (`google_id`, `facebook_id`, `twitter_id`)
- Hedera linkage (`hedera_account_id`, `kms_key_id`)

Every account uses one internal UUID (`id`).

## Session Model

- Access token: JWT (HS256), short-lived (`AUTH_ACCESS_TOKEN_TTL_MINUTES`, default 15m)
- Refresh token: opaque random token in HttpOnly cookie (`/api/auth` path)
- Refresh rotation: old refresh token revoked when exchanged, new one issued

Refresh tokens are persisted hashed in `refresh_tokens` to avoid storing plaintext.

## Security Controls

- Password hashing: bcrypt (`AUTH_BCRYPT_COST`, default 12)
- Password policy: length + upper/lowercase + digit + symbol
- Rate limiting: in-memory per-IP limit on auth endpoints
- Cookie security: `HttpOnly`, `SameSite=Lax`, `Secure` in production
- Secrets in env vars (`AUTH_ACCESS_TOKEN_SECRET`, OAuth client secrets)

## Wallet Provisioning (AWS KMS + Hedera)

- On new user creation (email signup or first-time OAuth), backend provisions a managed wallet.
- A dedicated AWS KMS asymmetric key is created per user (`ECC_SECG_P256K1`, `SIGN_VERIFY`).
- Hedera account is created with the derived ECDSA(secp256k1) public key.
- Persisted on `users`: `hedera_account_id` and `kms_key_id` (ARN/KeyId).
- Private keys never leave AWS KMS; signing is performed through `kms:Sign`.

Required environment variables:

- `HEDERA_WALLET_PROVISIONING_ENABLED` (default `true`)
- `AWS_REGION`
- `HEDERA_NETWORK` (`testnet` or `mainnet`)
- `HEDERA_OPERATOR_ID`
- `HEDERA_OPERATOR_KEY`
- `HEDERA_NEW_ACCOUNT_INITIAL_HBAR` (default `1`)
- `HEDERA_KMS_CREATE_ALIAS` (default `true`)
- `HEDERA_KMS_ALIAS_PREFIX` (default `alias/workit-user`)
- `HEDERA_KMS_KEY_DESCRIPTION_PREFIX`

Runtime dependencies required in deployment:

- `@aws-sdk/client-kms`
- `@hashgraph/sdk`

Note: AWS automatic rotation is not available for asymmetric KMS keys (`ECC_SECG_P256K1`), so rotation requires explicit key replacement plus Hedera `AccountUpdate` key migration.

## OAuth Notes

- Google: server-side ID token signature verification via Google JWKS.
- Facebook/X(Twitter): route scaffolding exists; by default these require full provider verification implementation.
- For local demos only, `OAUTH_TRUSTED_PROFILE_MODE=true` can allow trusted-profile input for Facebook/Twitter endpoints.
