# @workit-poa/hedera-kms-wallet-demo

Standalone demo package for `@workit-poa/hedera-kms-wallet`.

## Run

1. Copy `examples/hedera-kms-wallet-demo/.env.example` to `.env` in the same folder.
2. Set the required AWS and Hedera values.
3. Compile Hardhat contracts (required for default deploy mode):

```bash
pnpm --filter @workit-poa/contracts compile
```

4. Run:

```bash
pnpm --filter @workit-poa/hedera-kms-wallet-demo demo:kms-hedera
```

## Demo modes

- `DEMO_MODE=deploy` (default): provisions/loads a KMS wallet and deploys the Hardhat artifact at `DEMO_HARDHAT_ARTIFACT_PATH`.
- `DEMO_MODE=topic`: submits an HCS topic message.
- `DEMO_MODE=transfer`: submits an HBAR transfer.

In `deploy` mode the demo also attempts to resolve and print:
- HashScan mirror transaction link
- Mirror REST contract result URL

Optional override:
- `DEMO_MIRROR_REST_URL` (for custom mirror endpoints, e.g. local environments)
