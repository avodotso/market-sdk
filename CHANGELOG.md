# Changelog

All notable changes to `@avodotso/market-sdk`. This project follows [Semantic Versioning](https://semver.org/).

## 2.0.0

**Breaking: agent auth is now a request-bound `Sig2`.**

The Avo API now refuses the reusable `Sig` token on every write, on bearer rotation and on admin routes. It accepts that token on GET routes only, until a short compatibility window closes (no later than 2026-12-02). A captured `Sig` could be replayed against any route until it expired, so the API now requires a signature for each request.

- In `Sig` mode, `MarketClient` signs a fresh `Sig2` for every authenticated call. Each one is bound to the method, the path and sorted query, the SHA-256 of the exact body bytes sent, and a single-use nonce (`avo-portfolio-api/v3`). Nothing is cached or reused. Through the gateway (`gatewayAuthorization`), the `Sig2` still rides in `x-avo-agent-authorization`.
- `tokenTtlSecs` now sets each `Sig2`'s lifetime: 60 s by default, capped at 120 s (the API's ceiling). It used to set the reusable token's lifetime (600 s by default).
- An external `signer` is now called once per request, with that request's `Sig2` message.
- Bearer mode is unchanged, except that a bearer can no longer rotate itself. `POST /v1/markets/bearer/rotate` needs a `Sig2` from the agent key or the market creator.

**Upgrade before the window closes.** Versions before 2.0.0 in `Sig` mode fail every write as soon as the API change is deployed, and fail reads once the window closes.

### Added

- `mintRequestSig(input, { method, url, body }, { ttlSecs?, nonce? })` returns a complete `Authorization` value for one request. Use it to sign calls the client does not wrap.
- Also new: `requestSigMessage`, `canonicalRequestTarget`, `bodySha256Hex`, `generateRequestNonce`, `REQUEST_SIG_AUDIENCE`, `REQUEST_SIG_MAX_TTL_SECS`, `REQUEST_SIG_DEFAULT_TTL_SECS` and the type `SignedRequestTarget`.

### Deprecated

- `mintAuthToken` and `canonicalAuthMessage`. They still work on GET routes during the compatibility window.

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
