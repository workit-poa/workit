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

## Workit Landing + Demo Auth

- Run locally:
  - `pnpm install`
  - `pnpm --filter @workit/web dev`
  - Open `http://localhost:3000` for the landing page, `http://localhost:3000/auth` for auth entry, and `http://localhost:3000/app` for the protected shell.
- Where to change copy:
  - Landing content sections: `apps/web/components/landing/landing-page.tsx`
  - Quest showcase cards: `apps/web/components/landing/quest-card.tsx`
  - Sample proof receipt fields: `apps/web/components/landing/receipt-viewer.tsx`
  - Auth messaging and labels: `apps/web/components/auth/auth-entry-panel.tsx` (Formik + Yup OTP/OAuth panel)
- Where to plug in real auth later:
  - Replace demo functions in `apps/web/lib/demo-auth.ts` with API-backed calls.
  - Keep app state wiring in `apps/web/components/auth/auth-provider.tsx`.
  - Route protection logic for `/app` lives in `apps/web/components/app/app-shell.tsx` (swap to server/session guard when backend auth is ready).
