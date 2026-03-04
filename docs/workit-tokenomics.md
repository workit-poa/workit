# WorkIt Tokenomics (EVM)

## Overview
The WorkIt EVM tokenomics keeps the GainzSwap architecture pattern while repurposing the core economy around `WORKIT`:

- `WorkitToken`: native ERC20 (`WorkIt`, `WORKIT`) with role-based minting.
- `WorkitEmissionManager`: epoch emissions with `Entities` split (team, growth, liquidity incentive, staking).
- `WorkitLaunchpad`: campaign lifecycle to list `WORKIT` against quote tokens on UniswapV2-compatible DEXes.
- `WorkitGToken`: pool-keyed ERC1155 listing/security series.
- `WorkitStaking`: stake listing GTokens and accrue emissions.
- `WorkitGovernance`: proposal/vote/execute for campaign finalization, pool emissions, quote tokens, treasury updates.

## Token Flow

### 1) WORKIT minting and emission split
`WorkitEmissionManager` computes epoch emissions with the same decay model used in Gainz (`GainzEmission`).

Each emission is split using the same `Entities` distribution logic:
- staking share
- team share
- growth share
- liquidity-incentive share

Staking share is minted to `WorkitStaking` (`mintForStaking`).
Other entity shares are tracked and later claimable through `claimEntityFunds`.

### 2) Launchpad campaign to DEX pool
Campaign flow:
1. `createCampaign(quoteToken, workitGoal, quoteGoal, deadline)`
2. users deposit WORKIT + quote token
3. governance/authorized role finalizes
4. launchpad ensures pool exists (`factory.getPair` / `createPair`)
5. liquidity is added through `router.addLiquidity`
6. resulting pair address is stored as campaign pool

Launchpad emits campaign/deposit/finalization/pool/liquidity events.

### 3) Pool-keyed GToken series
For each listing pool, one listing series is registered in `WorkitGToken`:

- `pool -> gTokenId`
- `gTokenId -> pool/config`

ID derivation:
- `tokenId = uint256(keccak256(abi.encodePacked(chainid, poolAddress)))`

Security/listing separation is preserved with `SeriesType` (`Listing`, `Security`).
Staking accepts only listing series.

### 4) GToken denomination
GToken minting is denominated in WORKIT provided at liquidity addition:

- user WORKIT used in liquidity = `userWorkitDeposit * campaign.workitUsed / campaign.workitDeposited`
- minted listing GToken amount = `workitUsedByUser`

So GToken unit tracks WORKIT-denominated listing participation.

### 5) Staking and rewards
`WorkitStaking` validates listing tokens by pool identity:
- pool must be a registered listing pool
- provided tokenId must equal both stored and derived pool tokenId

Rewards:
- staking contract syncs new emitted WORKIT
- rewards are distributed by pool-weighted stake
- users claim via `claimRewards`
- users withdraw via `withdraw`

Pool-specific emission tuning is supported with `setPoolEmissionWeight(pool, weight)`.

### 6) Governance controls
`WorkitGovernance` proposals can execute:
- campaign finalization (`governanceFinalizeCampaign`)
- pool emission updates
- quote-token approvals
- treasury parameter updates in the emission manager

This creates a pool-based governance flow where approved campaigns end in:
- real pair creation,
- pool-keyed GToken series creation,
- staking enablement for the pool.
