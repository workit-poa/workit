# Architecture Notes

This monorepo uses Nx + pnpm workspaces to keep a fullstack Next.js app and shared TypeScript libraries in one repository.

Key benefits:

- Shared types and service contracts in `libs/common`.
- API routes and UI in `apps/web` for faster iteration during the hackathon.
- Unified identity in Drizzle (`users`) with OTP and OAuth account linking.
- Session handling delegated to NextAuth JWT strategy.
- Atomic cross-service changes in one PR.
- Affected-only CI jobs via Nx.
