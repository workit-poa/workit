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

## Start Hedera local stack (repo root)

```bash
pnpm hedera:local:start
pnpm hedera:local:status
pnpm hedera:local:keys
```

The local stack endpoints are:

- Consensus node: `http://localhost:50211`
- Mirror gRPC: `http://localhost:5600`
- Mirror REST: `http://localhost:5551`
- JSON-RPC relay: `http://localhost:7546`
- JSON-RPC relay WS: `http://localhost:8546`

`pnpm hedera:local:keys` generates `libs/contracts/.env.local` from funded account logs.

## Compile and test

```bash
pnpm --filter @workit-poa/contracts compile
pnpm --filter @workit-poa/contracts test
```

## Test against local Hedera relay

```bash
pnpm --filter @workit-poa/contracts ping:local
pnpm --filter @workit-poa/contracts test:local
```

`hederaLocal` in Hardhat is configured with:

- `url=http://localhost:7546`
- `chainId=298`
- `accounts` from `HEDERA_PRIVATE_KEY`, `HEDERA_PRIVATE_KEYS`, or generated `HEDERA_LOCAL_PRIVATE_KEY_*` values.

`ping:local` executes the Hardhat task `hedera:ping` and prints:

- `eth_chainId`
- `eth_blockNumber`

## Deploy to Hedera

Set keys in `libs/contracts/.env` or `libs/contracts/.env.local`, then run one of:

```bash
pnpm --filter @workit-poa/contracts deploy:local
pnpm --filter @workit-poa/contracts deploy:testnet
pnpm --filter @workit-poa/contracts deploy:previewnet
pnpm --filter @workit-poa/contracts deploy:mainnet
```

`deploy:local` expects a local Hedera JSON-RPC relay at `HEDERA_LOCAL_RPC_URL` (default `http://localhost:7546`).
These deploy scripts install `WorkEmissionController` and `GToken` (both behind proxy), deploy `Rewards`, and configure roles/collector:
- `WRK` WorkIt HTS fungible token via `WorkEmissionController`
- WorkIt governance HTS NFT token via `GToken`
- `Rewards` initialized with `workToken`, `gToken`, and `workEmissionController`
- `GToken.UPDATE_ROLE` granted to `Rewards`
- Controller staking collector set to `Rewards` (or `WORK_STAKING_ADDRESS` if provided)

Optional deploy env overrides (`libs/contracts/.env` or `.env.local`):
- `WORK_TOKEN_CREATE_HBAR_TO_SEND`
- `GOVERNANCE_NFT_CREATE_HBAR_TO_SEND`
- `DEPLOY_GAS_LIMIT`
- `GOVERNANCE_NFT_MAX_SUPPLY`
- `GTOKEN_EPOCH_LENGTH_SECONDS`
- `CREATE_GOVERNANCE_NFT`
- `WORK_REWARDS_ADDRESS` (reuse existing rewards)
- `WORK_STAKING_ADDRESS` (override collector)

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

## Local HCS + HTS helper scripts

Run from repo root:

```bash
pnpm hedera:hcs:local
pnpm hedera:hts:local
```

- `hedera:hcs:local`: creates an HCS topic and submits a message.
- `hedera:hts:local`: creates a fungible HTS token, associates recipient, and transfers tokens.

Both scripts use local operator/account env values from `libs/contracts/.env` or `.env.local`.
