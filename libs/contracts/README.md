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

## Hybrid Position Model (HTS + EVM)

`GToken` now uses a hybrid architecture:

- HTS (`0x167`) is the source of truth for position ownership and NFT serial supply.
- `HybridSFT`/`GToken` store EVM metadata (`tokenAttributes`), position value (`positionValue`), and split/merge rules.
- Split/merge mint and burn HTS NFT serials while preserving protocol-level invariants in Solidity.

### Association requirement

Accounts must be associated with the position NFT token before receiving position transfers/mints.
Use `associatePositionNft(account)` (admin-gated) or set auto-association externally.

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
Deploy flow:

1. Deploy `WORK`.
2. Create WRK HTS fungible token from the controller.
3. Deploy `GToken` (`constructor(admin, epochLength)`).
4. Create position NFT token via `createPositionNft(maxSupply, name, symbol, memo)`.
5. Optionally associate accounts from `POSITION_NFT_ASSOCIATE_ACCOUNTS`.
6. Deploy `Rewards` via UUPS `initialize` (or reuse `WORK_REWARDS_ADDRESS`).
7. Run contract token association planner for `Rewards` (`WRK`).
8. Grant `GToken.UPDATE_ROLE` to `Rewards`.
9. Set controller staking collector (`WORK_STAKING_ADDRESS` or rewards address).
10. Deploy `Staking` via UUPS `initialize`.
11. Run contract token association planner for `Staking` (`WRK`, and position NFT when configured).
12. Grant `GToken.MINTER_ROLE` to `Staking`.
13. Deploy `Launchpad` + `Campaign` beacon/proxies and create WRK/HBAR campaign.

After each successful deploy, the script also writes a deployment ABI library:

- `libs/contracts/deployments/<chainId>/<ContractName>.json`

Each file uses this schema:

```json
{
  "address": "0x...",
  "abi": []
}
```

Optional deploy env overrides (`libs/contracts/.env` or `.env.local`):

- `WORK_TOKEN_CREATE_HBAR_TO_SEND`
- `POSITION_NFT_CREATE_HBAR_TO_SEND`
- `DEPLOY_GAS_LIMIT`
- `POSITION_NFT_MAX_SUPPLY`
- `POSITION_NFT_NAME`
- `POSITION_NFT_SYMBOL`
- `POSITION_NFT_MEMO`
- `GTOKEN_EPOCH_LENGTH_SECONDS`
- `CREATE_POSITION_NFT`
- `POSITION_NFT_ASSOCIATE_ACCOUNTS`
- `WORK_REWARDS_ADDRESS`
- `WORK_STAKING_ADDRESS`
- `LAUNCHPAD_URI`
- `ICO_FUNDING_ASSET` (`HBAR` or `WHBAR`; both resolve to WHBAR on-chain)
- `ICO_GOAL` (funding goal amount in funding token smallest unit; default `100000000` = 1 HBAR)
- `ICO_DURATION_SECONDS` (must be greater than `60`; default `3600`)

Launchpad orchestration notes:

- Deploy script uses Hedera testnet defaults:
  - Router: `0.0.19264` (`0x0000000000000000000000000000000000004b40`)
  - Funding token (WHBAR): `0.0.15057` (`0x0000000000000000000000000000000000003ad1`)
  - Funding asset mode: `HBAR` by default (implemented via WHBAR at contract level)
  - Campaign token mode: `ethers.ZeroAddress` sentinel meaning "use deployed WRK"
  - Security nonces: `[]` (first campaign skips security GTokens)
  - Campaign supply: `WRK_ICO_FUNDS`
  - Campaign goal: `1 * 10^8` (1 HBAR)
  - Lock: `180` epochs
  - Duration: `3600` seconds (1 hour)
- `createWorkToken` now transfers ICO WRK supply directly to the owner during creation.

## Token association lifecycle

The protocol now uses a single, idempotent token-association strategy for Hedera:

- Shared Solidity helper: `contracts/libraries/HederaTokenAssociationLib.sol`.
- Runtime association in custody flows:
  - `Campaign`: funding token + campaign token.
  - `Launchpad`: newly created LP/pair token.
  - `Staking`: inbound stake tokens, LP/pair tokens, and configured position NFT.
  - `Rewards`: WRK token.
- Owner-managed lifecycle functions for post-deploy/post-upgrade migrations:
  - `Rewards.associateTokenIfNeeded`, `Rewards.associateTokensIfNeeded`, `Rewards.associateWorkTokenIfNeeded`.
  - `Staking.associateTokenIfNeeded`, `Staking.associateTokensIfNeeded`, `Staking.associateCoreTokensIfNeeded`.
  - `Staking.safeAssociateTokens` for trusted system callers (Launchpad) in pair creation/stake flows.
  - `Launchpad.associateTokensIfNeeded`.
- Script support:
  - `scripts/utils/token-association.ts` centralises idempotent planning/execution with retry logs.
  - `scripts/deploy.ts` and `scripts/upgrade-core-contracts.ts` call the planner automatically.
  - Deploy/upgrade scripts set `Staking.setAssociationCaller(launchpad, true)` so Launchpad can run `safeAssociateTokens`.
  - `scripts/resolve-campaigns.ts` refreshes campaign listing associations before resolution.

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
