# Hedera Local Node Helper

This folder provides repo-local wrappers for running the official Hiero local node stack (Consensus + Mirror + JSON-RPC relay).

## What it manages

- Upstream project: `https://github.com/hiero-ledger/hiero-local-node`
- Default clone path: `dev/hedera-local-node/hiero-local-node` (git-ignored)
- Endpoints used by this repo:
  - Consensus node: `http://localhost:50211`
  - Mirror gRPC: `http://localhost:5600`
  - Mirror REST: `http://localhost:5551`
  - JSON-RPC relay: `http://localhost:7546`
  - JSON-RPC relay WS: `http://localhost:8546`

## Commands

Run from repo root:

```bash
pnpm hedera:local:start
pnpm hedera:local:status
pnpm hedera:local:logs
pnpm hedera:local:keys
pnpm hedera:local:stop
```

`hedera:local:start` attempts to extract funded local accounts from startup logs into:

`libs/contracts/.env.local`

If the file is not generated, run `pnpm hedera:local:keys` after startup.

## Optional overrides

- `HEDERA_LOCAL_NODE_DIR`: alternate path for local node clone
- `HEDERA_LOCAL_NODE_REPO_URL`: alternate git remote
- `HEDERA_LOCAL_NODE_REPO_REF`: branch/tag (default `main`)
- `HEDERA_LOCAL_KEYS_ENV_FILE`: output path for generated env file
