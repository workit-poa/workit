# @workit-poa/contracts

Hardhat workspace for writing, testing, and deploying Solidity contracts to Hedera EVM networks.

## Setup

1. Create a local env file:

```bash
cp libs/contracts/.env.example libs/contracts/.env
```

2. Install dependencies from the repo root:

```bash
pnpm install
```

## Compile and test

```bash
pnpm --filter @workit-poa/contracts compile
pnpm --filter @workit-poa/contracts test
```

## Deploy to Hedera

Set `HEDERA_PRIVATE_KEY` in `libs/contracts/.env`, then run one of:

```bash
pnpm --filter @workit-poa/contracts deploy:local
pnpm --filter @workit-poa/contracts deploy:testnet
pnpm --filter @workit-poa/contracts deploy:previewnet
pnpm --filter @workit-poa/contracts deploy:mainnet
```

`deploy:local` expects a local Hedera JSON-RPC relay at `HEDERA_LOCAL_RPC_URL` (default `http://127.0.0.1:7546`).

## Open a console on Hedera

```bash
pnpm --filter @workit-poa/contracts console:local
pnpm --filter @workit-poa/contracts console:testnet
pnpm --filter @workit-poa/contracts console:previewnet
pnpm --filter @workit-poa/contracts console:mainnet
```

## Default network behavior

If `HEDERA_NETWORK` is set in `.env`, Hardhat uses it as the default when `--network` is not provided.

Valid values: `hardhat`, `local`, `testnet`, `previewnet`, `mainnet`.
