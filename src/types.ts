/**
 * Wire types for the Avo Portfolio API. Every atomic-unit value
 * (vault balances, NAV, share counts) arrives as a decimal string —
 * convert with `BigInt(...)` if you need arithmetic past the JS safe-
 * integer range.
 */

// ---------------------------------------------------------------------------
//  Health
// ---------------------------------------------------------------------------

export interface HealthResp {
  status: 'ok';
  rpcSlot: number;
  version: string;
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
  /** Operator-facing label. */
  label?: string;
  /** Trade-asset mints to register at create time (each registered at
   *  0% target weight). Max 8. */
  assetMints?: string[];
  /** Initial target-weight map keyed by mint, plus the special `'base'`
   *  key. Must sum to exactly 10_000 (100%). When set, finalize lands
   *  these weights on chain immediately after asset registration. */
  initialWeights?: Record<string, number>;
  /** Off-chain metadata pointer (200 char cap). */
  marketMetadataUri?: string;
}

export interface PrepareCreateMarketResp {
  agentPubkey: string;
  fundingLamports: number;
  /** Base64-encoded unsigned `VersionedTransaction`. Creator signs +
   *  submits, then calls `finalizeCreateMarket`. */
  fundingTx: string;
  nextStep: string;
}

export interface FinalizeCreateMarketBody {
  agentPubkey: string;
  /** Signature of the funding transfer. */
  fundingSignature: string;
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
  identity: {
    coreAssetAddress: string;
    agentUri: string;
    signature: string;
    collection: string;
  } | null;
  /** One-time bearer token — store immediately. The API only retains its
   *  sha256. Used for custodial-mode auth on subsequent agent-op calls. */
  bearer: string;
  bearerHashHex: string;
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
}

// ---------------------------------------------------------------------------
//  Markets — public list + per-market reads
// ---------------------------------------------------------------------------

export interface ListMarketsParams {
  /** Page size; server cap 200, default 50. */
  limit?: number;
  /** Skip-N offset; default 0. */
  offset?: number;
}

export interface AgentRatingBlock {
  compositeScore: number;
  dataCompleteness: number;
  subScores: Record<string, unknown>;
  computedAt: string;
}

/** One entry in `listMarkets()`. */
export interface MarketSummary {
  marketPda: string;
  marketIndex: number;
  label: string | null;
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
  totalShares: string;
  lastTotalValueBase: string;
  lastNavTs: number;
  marketFeeBps: number;
  rating: AgentRatingBlock | null;
}

export interface ListMarketsResp {
  markets: MarketSummary[];
  limit: number;
  offset: number;
  /** Total markets in the catalog before paging. */
  total: number;
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
  /** u64 decimal string (base atomic units). */
  totalValueBase: string;
  /** Unix seconds — `nav_ts` when this point was recorded on chain. */
  lastNavTs: number;
  /** Tx signature for the `update_nav` call, when known. */
  signature: string | null;
  /** ISO 8601 timestamp the API wrote the row. */
  recordedAt: string;
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
  /** Percent (0–100). Decimals allowed; coerced to bps via `round(weight×100)`. */
  weight: number;
}

export interface RebalanceBody {
  weights: WeightInput[];
  slippageBps?: number;
  deadlineSecs?: number;
  /** Per-leg dust threshold in atomic base units. Below this, the leg
   *  becomes a pure weight rewrite — no swap, no fee. */
  dustThresholdBase?: string | bigint;
  onlyDirectRoutes?: boolean;
  dexes?: string;
  excludeDexes?: string;
}

export interface RebalanceLegResult {
  mint: string;
  direction: 'buy' | 'sell' | 'none';
  /** Router that executed the swap (or `'none'` for weight-only legs). */
  router: 'dflow' | 'jupiter' | 'none';
  /** Tx signature for this leg's `rebalance_leg` call. Absent on `none`-
   *  router legs. */
  signature?: string;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  feeAssetExpectedOut: string | null;
  attempts: Array<{
    router: 'dflow' | 'jupiter';
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
}

export interface SimulateBody {
  weights: WeightInput[];
  slippageBps?: number;
  dustThresholdBase?: string | bigint;
}

export interface SimulatedLeg {
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
