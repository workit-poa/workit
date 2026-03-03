# Changelog

All notable changes to `@workit-poa/hedera-kms-wallet` are documented in this file.

## [0.2.0] - 2026-03-03

### Added

- Added optional `payerAccountId` support to Hedera transaction helpers so transactions can be signed by the KMS wallet while fees are paid by either:
  - the managed wallet account, or
  - a separate paymaster account (with required payer signature handling in integration flows).
- Added explicit requirement-to-implementation mapping in README to cover key management, security controls, auditability, and Hedera integration evidence.

### Changed

- Updated the standalone demo to set `payerAccountId` to the managed wallet account by default, so demo transaction fees are charged to the KMS-backed wallet instead of the operator.
- Expanded package documentation to include:
  - production-ready setup and usage guidance,
  - API parameter updates for payer selection,
  - working prototype coverage including `apps/web` auth onboarding integration.

### Docs

- Aligned `docs/authentication.md` wallet provisioning environment variable requirements with the actual secure key creation flow (`AWS_ACCOUNT_ID`, `KMS_KEY_ADMIN_PRINCIPAL_ARN`, `KMS_RUNTIME_SIGNER_PRINCIPAL_ARN`).

## [0.1.0] - 2026-03-03

Initial public npm release.

### Added

- Introduced the `@workit-poa/hedera-kms-wallet` package for AWS KMS-backed Hedera key management, provisioning, and signing (`9970d5a`).
- Added managed Hedera key rotation workflow and safety documentation for asymmetric KMS key replacement (`0b607ec`).
- Enforced explicit key policy binding inputs for provisioning and key creation paths (`c69b17c`).
- Added stronger access controls and structured audit logging across key operations (`8269f3c`).
- Moved the demo into a standalone example package: `examples/hedera-kms-wallet-demo` (`09a3838`).

### Changed

- Switched transaction signing internals to Hedera SDK signing helpers for better alignment with SDK behavior (`e5b6235`).
- Refactored provisioning to route optional funding controls through a single path (`5f7a1e5`).
- Simplified funding configuration and hardened demo fail-fast checks (`82e041f`).
- Migrated tests to Vitest and reorganized them into `src/__tests__` (`62c3987`, `d2428af`).
- Hardened package publishing metadata (license/files/repository/homepage, publish configuration) (`ac043f9`, `66277ad`).
- Renamed workspace/package scope from previous namespace to `@workit-poa` (`fae4aa0`).

### Fixed

- Corrected operator key parsing and aligned KMS signing behavior with Hedera expectations (`6493eef`).
- Replaced dynamic keccak import with static import to support Next.js builds (`7481fca`).
- Fixed demo shutdown behavior to exit cleanly on `SIGINT`, including `pnpm` execution paths (`81c51b6`, `5f91209`, `5f27a8f`).

### Docs and Env

- Added and aligned package `.env.example` values with runtime requirements (`ac043f9`, `f934466`).
- Expanded README guidance for provisioning, rotation, IAM policy boundaries, and auditability (`0b607ec`, `8269f3c`, `66277ad`).
