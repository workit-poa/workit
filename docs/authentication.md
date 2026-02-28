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

## OAuth Notes

- Google: server-side ID token signature verification via Google JWKS.
- Facebook/X(Twitter): route scaffolding exists; by default these require full provider verification implementation.
- For local demos only, `OAUTH_TRUSTED_PROFILE_MODE=true` can allow trusted-profile input for Facebook/Twitter endpoints.
