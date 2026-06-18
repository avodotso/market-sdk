// ===========================================================================
//  @avodotso/market-sdk — TypeScript client for the Avo Portfolio API.
//
//  Single primary export: `MarketClient`. Bootstrap an agent (custodial
//  or self-custodial), drive rebalances, push NAV updates, manage assets,
//  attach an MPL-8004 identity — all via one HTTP client.
//
//  See `README.md` for the integration walkthrough.
// ===========================================================================

// ---------------------------------------------------------------------------
//  Primary client + auth-message helper
// ---------------------------------------------------------------------------
export {
  MarketClient,
  buildAttachMessage,
  type MarketClientConfig,
  type MarketClientAgent,
} from './client';

// ---------------------------------------------------------------------------
//  Auth (Sig-token minting for external signers / outside-SDK verification)
// ---------------------------------------------------------------------------
export {
  canonicalAuthMessage,
  mintAuthToken,
  type SignerFn,
  type SignerInput,
} from './auth';

// ---------------------------------------------------------------------------
//  Config (single edit point for the API base URL)
// ---------------------------------------------------------------------------
export {
  DEFAULT_SERVICE_CONFIG,
  resolveServiceConfig,
  type AvoServiceConfig,
} from './config';

// ---------------------------------------------------------------------------
//  Errors raised by `MarketClient`
// ---------------------------------------------------------------------------
export { AvoSdkError, AvoTransportError } from './errors';

// ---------------------------------------------------------------------------
//  Wire types — return shapes from `MarketClient` methods. Re-exported so
//  callers can type their own helpers around the responses without
//  re-deriving the shapes.
// ---------------------------------------------------------------------------
export type {
  // Health
  HealthResp,
  // Bootstrap
  PrepareCreateMarketBody,
  PrepareCreateMarketResp,
  FinalizeCreateMarketBody,
  FinalizeCreateMarketResp,
  RegisterMarketBody,
  RegisterMarketResp,
  // Catalog + per-market reads
  ListMarketsParams,
  ListMarketsResp,
  MarketSummary,
  AgentRatingBlock,
  MarketEvent,
  MarketEventsResp,
  GetMarketEventsParams,
  NavHistoryPoint,
  NavHistoryResp,
  GetNavHistoryParams,
  // Agent ops
  MarketResp,
  AssetView,
  ValueResp,
  NavBody,
  NavResp,
  WeightInput,
  RebalanceBody,
  RebalanceLegResult,
  RebalanceResp,
  SimulateBody,
  SimulatedLeg,
  SimulateResp,
  AddAssetBody,
  AddAssetResp,
  RemoveAssetOpts,
  RemoveAssetResp,
  QuoteParams,
  QuoteResp,
  // Identity
  AgentIdentityResp,
  AgentReputationCache,
  AgentRatingFactor,
  AgentRatingSubScores,
  AgentRating,
  AttachIdentityBody,
  AttachIdentityResp,
} from './types';
