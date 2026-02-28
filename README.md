# Proof of Activity Monorepo

Nx + pnpm monorepo for a Hedera-focused hackathon stack with shared TypeScript libraries for backend and frontend.

## Structure

- `apps/frontend`: Web app shell
- `apps/backend`: Express API shell
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

