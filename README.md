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
pnpm dev
```

## Useful Commands

- `pnpm build`: Build all projects
- `pnpm test`: Run all tests
- `pnpm affected:build`: Build only affected projects
- `pnpm graph`: Visualize dependency graph
