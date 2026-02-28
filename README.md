# Proof of Activity Monorepo

Nx + pnpm monorepo for a Hedera-focused hackathon stack with a unified fullstack Next.js app and shared TypeScript libraries.

## Structure

- `apps/web`: Fullstack Next.js app (UI + API routes)
- `libs/common`: Shared DTOs and utilities
- `libs/auth`: Authentication domain logic
- `libs/hedera-kms-wallet`: AWS KMS-backed Hedera wallet provisioning/signing integration
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

- `POST /api/auth/otp/request`: request email OTP challenge.
- `GET|POST /api/auth/[...nextauth]`: NextAuth session, OTP credentials sign-in, and OAuth providers (Google, X, Discord).
- `GET /api/protected/profile`: middleware-protected sample route.

## Useful Commands

- `pnpm build`: Build all projects
- `pnpm test`: Run all tests
- `pnpm affected:build`: Build only affected projects
- `pnpm graph`: Visualize dependency graph

## Workit Landing + Auth

- Run locally:
  - `pnpm install`
  - `pnpm --filter @workit/web dev`
  - Open `http://localhost:3000` for the landing page, `http://localhost:3000/auth` for auth entry, and `http://localhost:3000/app` for the protected shell.
- Where to change copy:
  - Landing content sections: `apps/web/components/landing/landing-page.tsx`
  - Quest showcase cards: `apps/web/components/landing/quest-card.tsx`
  - Sample proof receipt fields: `apps/web/components/landing/receipt-viewer.tsx`
  - Auth messaging and labels: `apps/web/components/auth/auth-entry-panel.tsx` (Formik + Yup OTP/OAuth panel)
