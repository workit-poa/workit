# Architecture Notes

This monorepo uses Nx + pnpm workspaces to keep frontend, backend, and shared TypeScript libraries in one repository.

Key benefits:

- Shared types and service contracts in `libs/common`.
- Atomic cross-service changes in one PR.
- Affected-only CI jobs via Nx.

