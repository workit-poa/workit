# Proof of Activity Monorepo

Nx + pnpm monorepo for a Hedera-focused hackathon stack with a unified fullstack Next.js app and shared TypeScript libraries.

## Structure

- `apps/web`: Fullstack Next.js app (UI + API routes)
- `libs/common`: Shared DTOs and utilities
- `libs/auth`: Authentication domain logic
- `libs/wallet`: Wallet domain logic
- `libs/hedera`: Hedera SDK integration layer
- `infra/terraform`: Infrastructure as code
- `docs`: Project documentation

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm drizzle:generate
pnpm drizzle:migrate
pnpm dev
```

## Auth API

- `POST /api/auth/register`: email/password registration.
- `POST /api/auth/login`: email/password login.
- `POST /api/auth/oauth/google`: Google OAuth via ID token verification.
- `POST /api/auth/oauth/facebook` and `POST /api/auth/oauth/twitter`: available behind trusted profile mode.
- `POST /api/auth/refresh`: refresh token rotation (HttpOnly cookie).
- `POST /api/auth/logout`: revoke current refresh token.
- `GET /api/auth/me`: fetch current user from Bearer access token.
- `GET /api/protected/profile`: middleware-protected sample route.

## Useful Commands

- `pnpm build`: Build all projects
- `pnpm test`: Run all tests
- `pnpm affected:build`: Build only affected projects
- `pnpm graph`: Visualize dependency graph
