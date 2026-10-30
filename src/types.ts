/**
 * Wire types for the Avo Portfolio API. Every atomic-unit value
 * (vault balances, NAV, share counts) arrives as a decimal string —
 * convert with `BigInt(...)` if you need arithmetic past the JS safe-
 * integer range.
 */

// ---------------------------------------------------------------------------
//  Health
// ---------------------------------------------------------------------------

/** `GET /healthz`. api.avo.so returns exactly these three fields. */
export interface HealthResp {
  /** `'degraded'` when the RPC or database probe failed. Gate on `status === 'ok'`. */
  status: 'ok' | 'degraded';
  /** Null when the RPC probe failed. */
  rpcSlot: number | null;
  version: string | null;
}

// ---------------------------------------------------------------------------
//  Bootstrap — agent / market creation
// ---------------------------------------------------------------------------

export interface PrepareCreateMarketBody {
  /** Creator wallet pubkey — funds the agent + signs the funding transfer. */
  creator: string;
  baseAssetMint: string;
  /** Mint fees accrue in. Often === `baseAssetMint`. */
  feeAssetMint: string;
  /** Per-swap market fee in basis points (`0..10_000`). Total fee on a
   *  swap is `platformFeeBps + marketFeeBps`; the on-chain handler caps
   *  the sum at 10_000. */
  marketFeeBps: number;
  /** Operator-facing label (max 120 chars). */
  label?: string;
  /** Trade-asset mints to register at create time (each registered at
   *  0% target weight). Max 24. */
  assetMints?: string[];
  /** Initial target-weight map keyed by mint, plus the special `'base'`
   *  key. Must sum to exactly 10_000 (100%). When set, finalize lands
   *  these weights on chain immediately after asset registration. */
  initialWeights?: Record<string, number>;
  /** Off-chain metadata pointer (200 char cap). */
  marketMetadataUri?: string;
  /** HTTPS or `ipfs://` image URL for the market card (500 char cap). */
  portfolioImage?: string;
  /** `'managed'` (driven from the Avo app) or `'programmatic'` (bearer /
   *  script driven). Server default `'programmatic'`. */
  marketType?: 'managed' | 'programmatic';
  /** Programmatic markets only: `'index'` (default) or `'agent'`. */
  programmaticVariant?: 'index' | 'agent';
  /** Market description shown on the market page (2000 char cap). */
  description?: string;
}

export interface PrepareCreateMarketResp {
  /** `PendingMarket.id`. Signed into `creatorAuth` at finalize. */
  pendingId: string;
  agentPubkey: string;
  fundingLamports: number;
  /** Base64-encoded unsigned `VersionedTransaction`. Creator signs +
   *  submits, then calls `finalizeCreateMarket`. */
  fundingTx: string;
  /** Transaction version of `fundingTx`. */
  version: 'legacy' | 0 | 1;
  nextStep: string;
}

export interface FinalizeCreateMarketBody {
  agentPubkey: string;
  /** Signature of the funding transfer. */
  fundingSignature: string;
  /** Creator-signed binding from `buildCreatorAuth`. Single-use and valid
   *  for at most 110s, so build a fresh one for every finalize attempt. */
  creatorAuth: string;
}

export interface FinalizeCreateMarketResp {
  agentId: string;
  marketId: string;
  marketPda: string;
  marketIndex: number;
  agentPubkey: string;
  funded: boolean;
  fundedTx: string;
  createMarketSignature: string;
  assetSignatures: string[];
  weightSetSignatures: { prepare: string; settle: string } | null;
  /** The market's on-chain deposit gate after finalize. `null` when it could
   *  not be verified. */
  depositsOpen?: boolean | null;
  identity: {
    coreAssetAddress: string;
    agentUri: string;
    signature: string;
    collection: string;
  } | null;
  /** One-time bearer token — store immediately. The API only retains its
   *  sha256. Used for custodial-mode auth on subsequent agent-op calls.
   *  Empty string when `converged` is true: a retried finalize never
   *  re-issues the bearer. Mint a new one with `POST /v1/markets/bearer/rotate`. */
  bearer: string;
  bearerHashHex: string;
  /** True when an earlier finalize already created this market. No on-chain
   *  work ran and no bearer was minted. */
  converged?: boolean;
}

export interface RegisterMarketBody {
  /** Market PDA from your on-chain `create_market` ix. */
  marketPda: string;
  /** Base58-encoded 64-byte Ed25519 secret key for the agent that owns
   *  the market on chain. Validated against `Market.agent` before any
   *  DB write. Encrypted at-rest server-side and never echoed back —
   *  the response returns a one-time bearer instead. */
  agentSecretBase58: string;
  label?: string;
  /** Optional Metaplex Core collection pubkey for MPL-8004 gating. */
  agentIdentityCollection?: string;
}

export interface RegisterMarketResp {
  agentId: string;
  marketId: string;
  marketPda: string;
  marketIndex: number;
  agentPubkey: string;
  /** One-time bearer token. Re-register the same market to rotate. */
  bearer: string;
  bearerHashHex: string;
  /** Shadow portfolio id in portfolio-service, when registered. */
  portfolioServiceId: string | null;
}

// ---------------------------------------------------------------------------
//  Markets — public list + per-market reads
// ---------------------------------------------------------------------------

export interface ListMarketsParams {
  /** Page size; server cap 200, default 50. */
  limit?: number;
  /** Skip-N offset; default 0. */
  offset?: number;
  /** Include closed markets. Default false. */
  includeClosed?: boolean;
  /** Exact lookup of one market by PDA (also returns markets hidden from the
   *  default listing). */
  marketPda?: string;
  /** Filter by shadow portfolio id. */
  portfolioServiceId?: string;
  /** Default `'newest'`. */
  sort?: 'newest' | 'popular';
}

export interface AgentRatingBlock {
  compositeScore: number;
  dataCompleteness: number;
  subScores: Record<string, unknown>;
  computedAt: string;
}

export interface DepositMinimumSummary {
  status: 'available' | 'unavailable' | 'pending';
  minimumUsd: number | null;
  averageDepositUsd: number;
  aboveAverageDeposit: boolean;
  defaultMinimumUsd: number | null;
  requiredToleranceBps: number | null;
  suggestedToleranceBps: number | null;
  warning: string | null;
  reason:
    | 'unroutable_asset'
    | 'token_floor_pending'
    | 'quote_transport_error'
    | 'higher_price_impact'
    | 'no_passing_amount'
    | 'unpriced_asset'
    | null;
  computedAt: string | null;
}

export interface MarketEligibility {
  restricted: boolean;
  code: 'LOCATION_RESTRICTED' | 'LOCATION_UNKNOWN' | 'LOCATION_INVALID' | 'GEOFENCE_UNAVAILABLE' | null;
  message: string | null;
  policyRevision: number;
  restrictedMints: string[];
}

/** One market, as returned by `listMarkets()`. */
export interface MarketSummary {
  marketPda: string;
  marketIndex: number;
  label: string | null;
  description: string | null;
  creator: string;
  marketType: 'managed' | 'programmatic';
  /** True for agent-driven programmatic markets. */
  agentic: boolean;
  agentPubkey: string;
  agentLabel: string | null;
  agentIdentityCollection: string | null;
  agentCoreAssetAddress: string | null;
  /** True when hydration observed the agent no longer owns its attached
   *  Core asset (transferred / burned). Distinct from revocation. */
  agentOwnershipLost: boolean;
  baseAssetMint: string;
  baseAssetVault: string;
  feeAssetMint: string;
  targetAssetCount: number;
  baseTargetWeightBps: number;
  /** Base atomic units per share atomic unit, as a decimal string with
   *  exactly 12 fractional digits. Null when the share supply is zero or the
   *  on-chain read is degraded. Public. */
  navPerShare: string | null;
  /** Whether the market has a non-zero share supply. Null when unknown. */
  funded: boolean | null;
  /** Share supply (u64 decimal string). Returned only to admin callers and
   *  the market creator (request-bound `Sig2`); absent on public reads. */
  totalShares?: string;
  /** Cached market total value in base atomic units. Same visibility as
   *  `totalShares`: absent on public reads. */
  lastTotalValueBase?: string;
  lastNavTs: number;
  marketFeeBps: number;
  platformFeeBps: number;
  portfolioImage: string | null;
  portfolioServiceId: string | null;
  lookupTable: string | null;
  closedAt: string | null;
  closingAt: string | null;
  depositsOpen: boolean;
  onchainDepositGate: 'open' | 'closed' | 'unknown';
  closingReason:
    | 'shares_outstanding'
    | 'pending_plans'
    | 'deposit_gate_open'
    | 'awaiting_program_support'
    | null;
  depositMinimum: DepositMinimumSummary;
  rating: AgentRatingBlock | null;
  /** Per-caller geofence view. Informational. */
  eligibility: MarketEligibility;
  /** Market AUM in USD, refreshed at most every 90 s. Null when not valued. */
  aumUsd: number | null;
}

export interface ListMarketsResp {
  markets: MarketSummary[];
  limit: number;
  offset: number;
  /** Total markets in the catalog before paging. */
  total: number;
  /** True when the on-chain read failed and some fields are placeholders. */
  degraded?: boolean;
}

export interface MarketEvent {
  /** ISO 8601 timestamp. */
  created_at: string;
  message: string;
  status: 'SUCCESS' | 'DANGER' | 'WARNING' | 'INFO' | 'SECONDARY';
  type: 'TRANSACTION' | 'USER_ACTION' | 'AI_ACTION' | 'DEFAULT';
  /** Solana tx signature — present on TRANSACTION events. */
  signature: string | null;
  slot: number | null;
  /** The market PDA the event belongs to. */
  portfolio_id?: string;
  process_id?: string | null;
}

export interface MarketEventsResp {
  events: MarketEvent[];
  /** Oldest signature in this page — pass as `before` to next call for paging. */
  oldest: string | null;
}

export interface GetMarketEventsParams {
  /** Server cap 200, default 100. */
  limit?: number;
  /** Signature to page back from (exclusive). */
  before?: string;
}

export interface NavHistoryPoint {
  /** Base atomic units per share atomic unit, decimal string with exactly 12
   *  fractional digits. Flow-neutral: use this for charts and returns. Public
   *  history only contains points where it is non-null. */
  navPerShare: string | null;
  /** Unix seconds — `nav_ts` when this point was recorded on chain. */
  lastNavTs: number;
  /** ISO 8601 timestamp the API wrote the row. */
  recordedAt: string;
  /** Market total value (u64 decimal string, base atomic units). Returned
   *  only to admin callers and the market creator (request-bound `Sig2`);
   *  absent on public reads, which is how `getNavHistory` calls. */
  totalValueBase?: string;
  /** Share supply at this snapshot. Same visibility as `totalValueBase`. */
  totalShares?: string | null;
  /** True when value and supply came from one market read. Same visibility. */
  sharesPaired?: boolean;
  /** Tx signature of the `update_nav` call. Same visibility. */
  signature?: string | null;
}

export interface NavHistoryResp {
  marketPda: string;
  points: NavHistoryPoint[];
  limit: number;
  order: 'asc' | 'desc';
  from: string | null;
  to: string | null;
}

export interface GetNavHistoryParams {
  /** Server cap 2000, default 500. */
  limit?: number;
  order?: 'asc' | 'desc';
  /** Inclusive lower bound on `recordedAt` (ISO 8601 string or Date). */
  from?: string | Date;
  /** Inclusive upper bound on `recordedAt`. */
  to?: string | Date;
}

// ---------------------------------------------------------------------------
//  Agent ops — protected
// ---------------------------------------------------------------------------

export interface MarketResp {
  index: number;
  pda: string;
  agent: string;
  baseAssetMint: string;
  baseAssetVault: string;
  targetAssetCount: number;
  baseTargetWeightBps: number;
  totalShares: string;
  lastTotalValueBase: string;
  lastNavTs: number;
  /** Platform (Avo) fee in basis points. */
  platformFeeBps: number;
  /** Market owner's fee in basis points. Total swap fee per leg =
   *  `platformFeeBps + marketFeeBps`. */
  marketFeeBps: number;
  /** Mint (base58) in which fees are denominated. */
  feeAssetMint: string;
}

export interface AssetView {
  mint: string;
  vault: string;
  lastKnownBalance: string;
  currentBalance: string;
  targetWeightBps: number;
  valueBase: string;
  currentWeightBps: number;
  unroutable: boolean;
}

export interface ValueResp {
  baseBalance: string;
  totalValueBase: string;
  baseCurrentWeightBps: number;
  perAsset: Array<{
    mint: string;
    balance: string;
    valueBase: string;
    currentWeightBps: number;
    unroutable: boolean;
  }>;
  pricedAt: number;
}

export interface NavBody {
  /** Optional. Atomic units of base. Omit to let the API quote live. */
  totalValueBase?: string | bigint;
  slippageBps?: number;
}

export interface NavResp {
  signature: string;
  totalValueBase: string;
  pricedAt?: number;
}

export interface WeightInput {
  /** `'base'` or a base58 MarketAsset mint. */
  asset: string;
  /** Percent (0–100). Decimals allowed; coerced to bps via `round(weight×100)`.
   *  Per-entry rounding introduces sum drift for fractional percents — for
   *  full 1-bps precision without drift, use `weightBps` instead. Either
   *  `weight` or `weightBps` MUST be present. */
  weight?: number;
  /** Basis points (0..10_000). Native on-chain unit. When present, `weight`
   *  is ignored, no conversion runs, and sums to 10_000 hold exactly.
   *  Prefer this for equal-weight indices (N≥5) and any allocation whose
   *  natural expression is sub-percent. */
  weightBps?: number;
}

/** POST /v1/agent/fees/withdraw — pull-out for the agent's fee ATA. */
export interface WithdrawAgentFeesBody {
  destinationWallet: string;
  /** Atomic units. Skip transfer if balance <= this. Default 0. */
  minFeeAmount?: string | bigint;
}

export interface WithdrawAgentFeesResp {
  /** Null when the endpoint no-oped (balance ≤ `minFeeAmount`). */
  signature: string | null;
  /** Amount transferred in atomic units of `feeAssetMint`. */
  amountWithdrawn: string;
  /** Post-transfer balance still in the agent fee ATA. */
  remainingBalance: string;
  feeAssetMint: string;
  destinationAta: string;
}

export interface RebalanceBody {
  weights: WeightInput[];
  slippageBps?: number;
  /** Fee conversion tolerance; independent of the main swap slippage. */
  feeSlippageBps?: number;
  deadlineSecs?: number;
  /** Per-leg dust threshold as bps of live NAV; default is server/market-specific.
   *  An explicit dustThresholdBase takes precedence. */
  dustThresholdBps?: number;
  /** Consent to the server's low-AUM referrer-fee override. */
  acceptLowAumTopup?: boolean;
  /** Correlation ID for server-side progress events. */
  progressId?: string;
  /** Per-leg dust threshold in atomic base units. Below this, the leg
   *  becomes a pure weight rewrite — no swap, no fee. */
  dustThresholdBase?: string | bigint;
  onlyDirectRoutes?: boolean;
  dexes?: string;
  excludeDexes?: string;
  /**
   * Clamp `new_total_value_base` per leg into ±20% of the on-chain
   * cache so `rebalance_leg`'s `MAX_NAV_DELTA_BPS` guard doesn't reject
   * a legitimate but stale NAV update. Enable for intermittent-trading
   * markets (RWAs / xStocks / Mag-7-style indices) where the cache
   * routinely drifts > 20% between rebalances. Off by default so 24/7
   * markets still surface real fat-finger anomalies.
   */
  capNavDelta?: boolean;
}

export interface RebalanceLegResult {
  mint: string;
  direction: 'buy' | 'sell' | 'none';
  /** Router that executed the swap (or `'none'` for weight-only legs). */
  router: 'dflow' | 'jupiter' | 'titan' | 'none';
  /** Tx signature for this leg's `rebalance_leg` call. Absent on `none`-
   *  router legs. */
  signature?: string;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  feeAssetExpectedOut: string | null;
  attempts: Array<{
    router: 'dflow' | 'jupiter' | 'titan';
    ok: boolean;
    reason?: string;
  }>;
  currentValueBase: string;
  targetValueBase: string;
  deltaBase: string;
  newTargetWeightBps: number;
}

export interface RebalanceResp {
  /** `prepare_rebalance` tx signature. */
  prepareSignature: string;
  /** `settle_rebalance` tx signature — closes the plan PDA. */
  settleSignature: string;
  totalValueBeforeBase: string;
  newBaseTargetWeightBps: number;
  legs: RebalanceLegResult[];
  /** The server accepted the existing composition after checking drift.
   *  Signatures can be empty when no transaction was needed. */
  driftAutoSuccess?: boolean;
  driftInfo?: {
    withinTolerance: boolean;
    maxAbsDriftBps: number;
    toleranceBps: number;
    perAsset: Array<{ mint: string; targetBps: number; currentBps: number; driftBps: number }>;
    suppressedError?: { code: string; message: string };
  };
}

export interface SimulateBody {
  weights: WeightInput[];
  slippageBps?: number;
  dustThresholdBase?: string | bigint;
  dustThresholdBps?: number;
}

export interface SimulatedLeg {
  /** True when no usable quote was found. Optional for older services. */
  unroutable?: boolean;
  unroutableReason?: string | null;
  mint: string;
  direction: 'buy' | 'sell' | 'none';
  amountIn: string;
  expectedOut: string;
  expectedFee: string;
  expectedFeeBase: string;
  expectedNetOut: string;
  currentValueBase: string;
  targetValueBase: string;
  deltaBase: string;
  currentWeightBps: number;
  newTargetWeightBps: number;
}

export interface SimulateResp {
  totalValueBeforeBase: string;
  totalFeeBase: string;
  estimatedTotalValueAfterBase: string;
  newBaseTargetWeightBps: number;
  legs: SimulatedLeg[];
  /** Platform (Avo) fee in basis points at simulate time. */
  platformFeeBps: number;
  /** Market owner's fee in basis points at simulate time. */
  marketFeeBps: number;
  pricedAt: number;
}

export interface AddAssetBody {
  mint: string;
}

export interface AddAssetResp {
  signature: string;
  marketAsset: string;
  vault: string;
}

export interface RemoveAssetOpts {
  slippageBps?: number;
  deadlineSecs?: number;
}

export interface RemoveAssetResp {
  signature: string;
  amountIn: string;
  expectedOut: string;
  minOut: string;
}

export interface QuoteParams {
  from: string;
  to: string;
  amount: string | bigint;
  slippageBps?: number;
  onlyDirectRoutes?: boolean;
}

export interface QuoteResp {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactBps: number;
}

// ---------------------------------------------------------------------------
//  Identity (MPL-8004) — public read + permissionless attach
// ---------------------------------------------------------------------------

export interface AgentReputationCache {
  tier: number | null;
  feedbackCount: number;
  validationScore: number | null;
  provenance: 'none' | 'metaplex' | 'atom_quantulabs';
  cachedAt: string;
}

export interface AgentRatingFactor {
  score: number;
  weight: number;
  dataMissing: boolean;
  raw?: Record<string, unknown>;
}

export interface AgentRatingSubScores {
  factors: Record<string, AgentRatingFactor>;
  dataCompleteness: number;
  compositeScore: number;
  revoked?: boolean;
}

export interface AgentRating {
  /** 0–100 weighted composite. */
  compositeScore: number;
  /** 0–1 fraction of total rubric weight backed by real data. */
  dataCompleteness: number;
  subScores: AgentRatingSubScores;
  /** ISO 8601 timestamp. */
  computedAt: string;
}

export interface AgentIdentityResp {
  agentPubkey: string;
  coreAssetAddress: string | null;
  agentUri: string | null;
  reputation: AgentReputationCache | null;
  rating: AgentRating | null;
  ownershipLost: boolean;
  ownershipLostAt: string | null;
}

export interface AttachIdentityBody {
  agentPubkey: string;
  /** Metaplex Core asset (NFT) address. On-chain owner must equal `agentPubkey`. */
  coreAssetAddress: string;
  /** Off-chain manifest URL. Must exactly equal the Core asset's on-chain `uri`. */
  agentUri: string;
  /** Unix ms timestamp the signature expires at. */
  expiresAtMs: number;
  /** Base58 Ed25519 signature over the canonical attach message. */
  signatureBase58: string;
}

export interface AttachIdentityResp {
  agentPubkey: string;
  coreAssetAddress: string;
  agentUri: string;
  /** ISO 8601 timestamp. */
  attachedAt: string;
}
