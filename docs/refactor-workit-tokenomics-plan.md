# WorkIt Tokenomics Refactor Plan

## Scope and constraints
- Reuse the existing GainzSwap architecture patterns (factory/router/pair, launchpad campaign lifecycle, staking-reward emissions split).
- Minimize invasive edits to legacy contracts by introducing WorkIt-focused contracts that interoperate with existing UniswapV2-compatible modules.
- Keep emissions/entity accounting logic consistent with current `GainzEmission + Entities` model.

## Recon summary (current state)

### Token layer
- Current native/reward token is `Gainz` (`libs/contracts/contracts/tokens/Gainz/Gainz.sol`).
- Emissions are epoch-based (`GainzEmission`) and split via `Entities` (team/growth/staking/liqIncentive).
- `Rewards` receives staking emissions and updates `rewardPerShare`.

### Launchpad / campaign
- `Launchpad` + `Campaign` handle listing funding and pair deployment.
- Pair deployment uses factory + deterministic pair address checks and LP staking handoff.
- Existing flow is dEDU/funding-token-centric and not WORKIT+quote dual-deposit campaign-native.

### Staking / rewards
- `Staking` mints `GToken` from LP positions and values LP in dEDU terms.
- `Rewards` distributes emissions by global stake weight and updates GToken attributes on claim.

### GToken model
- Current `GToken` extends SFT/ERC1155 and mints incremental nonce IDs.
- IDs are not pool-keyed today.

### Governance
- Current `Governance` is migration-centric and not cleanly proposal-driven for pool campaign approvals/emission policy.

### Entity accounting
- Emission split and deferred entity balances are in `GainzEmission.Entities` + `Gainz` storage.

## Refactor strategy
- Introduce WorkIt-specific contracts that preserve the same logical components:
  - token + emissions manager
  - launchpad campaign lifecycle
  - pool-keyed GToken series
  - staking + rewards accrual
  - governance proposals/execution
- Reuse existing UniswapV2-compatible interfaces/contracts (`IUniswapV2Router`, `IUniswapV2Factory`, `IUniswapV2Pair`, `UniswapV2Factory`, `Router`).
- Keep legacy Gainz contracts compileable but not primary in WorkIt tests/deployment.

## Contract map (old -> new responsibility)
- `tokens/Gainz/Gainz.sol` -> `tokens/Workit/WorkitToken.sol` + `workit/WorkitEmissionManager.sol`
  - WorkitToken: role-based minting + treasury metadata
  - EmissionManager: epoch emission and `Entities` split, staking share distribution
- `staking/Launchpad.sol` + `staking/Campaign.sol` -> `workit/WorkitLaunchpad.sol`
  - Campaign creation, WORKIT+quote deposits, governance-authorized finalization, router liquidity add, pool creation events
- `tokens/GToken/GToken.sol` (nonce IDs) -> `workit/WorkitGToken.sol`
  - Pool-keyed token ID series
  - `pool -> tokenId` and `tokenId -> pool/config`
  - listing/security series separation
- `staking/Staking.sol` + `staking/Rewards.sol` -> `workit/WorkitStaking.sol`
  - Stake pool-keyed GTokens, pool-weighted emissions, claim/withdraw accounting
- `Governance.sol` -> `workit/WorkitGovernance.sol`
  - Proposal/vote/execute for campaign finalization, pool emissions weights, quote-token approvals, treasury params

## Token ID and denomination rules
- Listing token ID formula:
  - `tokenId = uint256(keccak256(abi.encodePacked(block.chainid, poolAddress)))`
  - Optional params are omitted by default because pool address already uniquely identifies the listing pair.
- GToken mint denomination:
  - `gMint = workitUsedByUser`
  - Where `workitUsedByUser = userWorkitDeposit * campaign.workitUsed / campaign.totalWorkitDeposited`.

## Files to add
- `libs/contracts/contracts/tokens/Workit/WorkitToken.sol`
- `libs/contracts/contracts/workit/interfaces/IWorkitGToken.sol`
- `libs/contracts/contracts/workit/interfaces/IWorkitLaunchpad.sol`
- `libs/contracts/contracts/workit/interfaces/IWorkitStaking.sol`
- `libs/contracts/contracts/workit/interfaces/IWorkitEmissionManager.sol`
- `libs/contracts/contracts/workit/WorkitGToken.sol`
- `libs/contracts/contracts/workit/WorkitEmissionManager.sol`
- `libs/contracts/contracts/workit/WorkitLaunchpad.sol`
- `libs/contracts/contracts/workit/WorkitStaking.sol`
- `libs/contracts/contracts/workit/WorkitGovernance.sol`
- `libs/contracts/scripts/deploy.ts`
- `libs/contracts/scripts/workit-e2e.ts`
- `libs/contracts/test/workit/workit-tokenomics.test.ts`
- `docs/workit-tokenomics.md`

## Files to edit (minimal)
- No destructive rewrites of legacy GainzSwap contracts planned.
- Minor export/import wiring updates only if compile-time references require it.

## Storage-layout / upgradeability risks
- Legacy contracts are upgradeable and use ERC-7201 namespaced storage.
- To avoid storage collision/regression risk, WorkIt contracts are introduced as new deployments (non-upgrade migration path for this repo scope).
- If later migrated behind proxies, storage slots must be frozen and initializer patterns introduced; out of this refactor’s scope.

## Test plan
1. Launchpad campaign creates pool and adds liquidity via router/factory.
2. GToken ID derivation equals `keccak256(chainid, pool)` and maps pool<->tokenId.
3. Minted GToken amount equals WORKIT used in liquidity add (denomination invariant).
4. Stake listing GToken -> accrue emissions -> claim rewards -> withdraw stake with accounting checks.
5. Governance proposal lifecycle:
   - approve/finalize campaign
   - set pool emission weight
   - approve quote token
   - set treasury.
6. End-to-end integration:
   - deploy WORKIT + infra
   - fund user
   - create/deposit/finalize campaign
   - claim GToken
   - stake
   - advance time/epochs
   - claim rewards
   - withdraw
   - assert balances/events/invariants.

## Implementation order
1. Add Workit token + emission manager.
2. Add pool-keyed GToken.
3. Add launchpad campaign flow with router/factory integration.
4. Add staking/reward accounting over listing GTokens.
5. Add governance proposals/execution hooks.
6. Add deploy scripts and tests.
7. Compile + test + write tokenomics doc.
