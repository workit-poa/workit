# Architecture Notes

This monorepo uses Nx + pnpm workspaces to keep a fullstack Next.js app and shared TypeScript libraries in one repository.

Key benefits:

- Shared types and service contracts in `libs/common`.
- API routes and UI in `apps/web` for faster iteration during the hackathon.
- Unified identity in Drizzle (`users` + `refresh_tokens`) with email/password and OAuth account linking.
- Short-lived JWT access tokens plus refresh-token rotation for session continuity.
- Atomic cross-service changes in one PR.
- Affected-only CI jobs via Nx.
