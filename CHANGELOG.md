# Changelog

All notable changes to `@avodotso/market-sdk`. This project follows [Semantic Versioning](https://semver.org/).

## 1.0.0

The wire types now describe what the Avo API (`https://api.avo.so`) actually returns. Public reads never carry raw market value, vault balances or share supply. They are returned only to the market creator (request-bound `Sig2`) and admin callers, so the types no longer promise them.

### Breaking changes (types)

- **`MarketSummary`** (`listMarkets()` items): `totalShares` and `lastTotalValueBase` are now **optional**. They are absent on every public read; on `0.3.0` they were typed `string` but arrived as `undefined`. Use `navPerShare` for value-per-share and charts.
- **`NavHistoryPoint`** (`getNavHistory()` points):
  - adds `navPerShare: string | null`, the only value a public point carries (12-decimal string, flow-neutral);
  - `totalValueBase` is now **optional** (was `string`);
  - `signature` is now optional (was `string | null`);
  - new optional `totalShares` and `sharesPaired`.

  The last three, and `totalValueBase`, are creator/admin only.
- **`HealthResp`**: `status` is `'ok' | 'degraded'` (was `'ok'`); `rpcSlot` and `version` are nullable.

If your code reads `m.totalShares`, `m.lastTotalValueBase` or `point.totalValueBase` as a `string`, it now fails to type-check. That is intended: those reads were already `undefined` at runtime against the public API.

### Added

- `MarketSummary` gains the fields the API returns:
  - pricing and funding: `navPerShare`, `funded`, `platformFeeBps`, `aumUsd`;
  - identity and type: `creator`, `marketType`, `agentic`, `description`, `portfolioImage`, `portfolioServiceId`;
  - deposits: `depositsOpen`, `onchainDepositGate`, `depositMinimum`;
  - lifecycle: `closedAt`, `closingAt`, `closingReason`;
  - other: `lookupTable`, `eligibility`.

  New exported types `DepositMinimumSummary` and `MarketEligibility`. `ListMarketsResp` gains optional `degraded`.
- `listMarkets()` accepts `includeClosed`, `marketPda`, `portfolioServiceId` and `sort` (`'newest' | 'popular'`).
- `PrepareCreateMarketBody` gains `portfolioImage`, `marketType`, `programmaticVariant` and `description`. The documented `assetMints` cap is 24. `PrepareCreateMarketResp` gains `version` (the funding transaction's version).
- `FinalizeCreateMarketResp` gains `depositsOpen` and `converged`. A retried finalize that already succeeded returns `converged: true` with an empty `bearer`; mint a new one with `POST /v1/markets/bearer/rotate`. `RegisterMarketResp` gains `portfolioServiceId`.
- `MarketEvent` gains optional `portfolio_id` and `process_id`.
- `RETRYABLE_FINALIZE_CODES` is exported.

### Changed

- `createMarketWithShadowPortfolio()` also retries **`FUNDING_TX_NOT_FINALIZED`**. Since market-service #220, finalize acts only on a *finalized* funding transfer and answers `409 FUNDING_TX_NOT_FINALIZED` with `Retry-After` while it is confirmed but not final. Each retry signs a fresh `creatorAuth`, as before.
- `createMarketWithShadowPortfolio()` retries are bounded. `maxFinalizeAttempts` must be an integer 1–20 (default 4); `Infinity` used to retry forever. New `finalizeDeadlineMs` (integer 1 000–900 000, default 180 000) stops new attempts once the wall-clock budget from funding is spent, setting `details.deadlineExceeded`. Invalid values throw `INVALID_FINALIZE_OPTIONS` before anything is funded. `MAX_FINALIZE_ATTEMPTS`, `DEFAULT_FINALIZE_DEADLINE_MS` and `MAX_FINALIZE_DEADLINE_MS` are exported.
- Unchanged, by design: the helper does **not** retry finalize's `503` codes (`FINALIZE_IN_PROGRESS`, `FINALIZE_LEASE_LOST`, `FINALIZE_LOOKUP_TABLE_UNRESOLVED`, `FINALIZE_UNAVAILABLE`). They mean another finalize for the same agent is running or has not settled, and retrying can converge on that market with an empty `bearer`; the caller must decide (see the README's create-market section).

## 0.3.0

- **Breaking:** `finalizeCreateMarket()` requires a creator-signed `creatorAuth` (`buildCreatorAuth`). `createMarketWithShadowPortfolio()` takes a required `signMessage` callback and retries `FUNDING_TX_NOT_FOUND` / `FUNDING_TX_LOOKUP_FAILED`. `PrepareCreateMarketResp` gains `pendingId`.

## 0.2.1

- `gatewayAuthorization` for gateway deployments: the gateway credential goes in `Authorization`, agent auth in `x-avo-agent-authorization`.
- `rebalance()` surfaces failures sent as HTTP 200 `{ __rebalanceError }` as `AvoSdkError`. `AvoSdkError.retryAfterMs` parses `Retry-After`.
