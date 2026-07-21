/**
 * `MarketClient` — primary client for the Avo Portfolio API.
 *
 * One class covers the full market-maker journey:
 *
 *   • **Bootstrap** (no auth) — `prepareCreateMarket`, `finalizeCreateMarket`,
 *     `registerMarket`. Create an agent custodially (API holds the
 *     keypair) or register an externally-built market with a keypair
 *     you generated yourself.
 *   • **Public reads** (no auth) — `healthz`, `listMarkets`,
 *     `getMarketEvents`, `getNavHistory`, `getIdentity`, `attachIdentity`.
 *   • **Agent ops** (authenticated) — `getMarket`, `getAssets`,
 *     `getValue`, `getQuote`, `updateNav`, `rebalance`, `simulateRebalance`,
 *     `addAsset`, `removeAsset`, `getOwnIdentity`.
 *
 * Auth supports two modes, pick at construction:
 *
 *   • **Custodial (bearer)** — `agent: { bearer: '...' }`. API holds the
 *     agent keypair encrypted at rest. The bearer is the one-time token
 *     returned by `finalizeCreateMarket` / `registerMarket`. You never
 *     touch a private key.
 *
 *   • **Self-custodial (Sig)** — `agent: { publicKey, secretKey }` (or
 *     `signer`). You hold the keypair; the SDK mints short-lived signed
 *     tokens over a canonical message on every call window. External
 *     signers (KMS / hardware wallet / Turnkey / etc.) supported via the
 *     `signer: SignerFn` slot in place of `secretKey`.
 *
 * Both modes resolve to the same agent identity on the API side and have
 * identical access to every protected method.
 */
import bs58 from 'bs58';

import { HttpBase, type HttpBaseConfig } from './http-base';
import { mintAuthToken, type SignerInput, type SignerFn } from './auth';
import { AvoSdkError } from './errors';
import type {
  AddAssetBody,
  AddAssetResp,
  AgentIdentityResp,
  AssetView,
  AttachIdentityBody,
  AttachIdentityResp,
  FinalizeCreateMarketBody,
  FinalizeCreateMarketResp,
  GetMarketEventsParams,
  GetNavHistoryParams,
  HealthResp,
  ListMarketsParams,
  ListMarketsResp,
  MarketEventsResp,
  MarketResp,
  NavBody,
  NavHistoryResp,
  NavResp,
  PrepareCreateMarketBody,
  PrepareCreateMarketResp,
  QuoteParams,
  QuoteResp,
  RebalanceBody,
  RebalanceResp,
  RegisterMarketBody,
  RegisterMarketResp,
  RemoveAssetOpts,
  RemoveAssetResp,
  SimulateBody,
  SimulateResp,
  ValueResp,
  WithdrawAgentFeesBody,
  WithdrawAgentFeesResp,
} from './types';

const ATTACH_AUDIENCE = 'avo-portfolio-api/8004-attach/v1';

/** Build the canonical attach-message the agent must sign for
 *  `attachIdentity()`. Literal `\n` newlines, ASCII only, no trailing
 *  newline — matches the API verifier byte-for-byte. */
export function buildAttachMessage(
  agentPubkey: string,
  coreAssetAddress: string,
  expiresAtMs: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${ATTACH_AUDIENCE}\n${agentPubkey}\n${coreAssetAddress}\n${expiresAtMs}`,
  );
}

export interface MarketClientAgent {
  /** 32-byte Ed25519 public key (the agent identity). Required for Sig
   *  auth; optional in bearer mode. Pass alongside `bearer` to enable
   *  `getOwnIdentity()` without an extra round trip. */
  publicKey?: Uint8Array;
  /** Sig-auth mode (self-custodial): 64-byte secret key — the SDK signs
   *  in-process with nacl. */
  secretKey?: Uint8Array;
  /** Sig-auth mode: external signer fn. Hands back the canonical message
   *  bytes — you return the 64-byte Ed25519 signature. */
  signer?: SignerFn;
  /** Bearer-auth mode (custodial): the one-time bearer returned by
   *  `finalizeCreateMarket` / `registerMarket`. The API holds the agent's
   *  keypair encrypted at rest; you never touch the private key. */
  bearer?: string;
}

export interface MarketClientConfig extends HttpBaseConfig {
  /** Agent identity for authenticated methods. Omit when the client is
   *  used only for bootstrap (`prepareCreateMarket` / `registerMarket`)
   *  or public reads (`listMarkets`, `healthz`, `getIdentity`). */
  agent?: MarketClientAgent;
  /** Sig-token TTL in seconds. Ignored in bearer mode. Default 600s.
   *  The API caps TTL server-side. */
  tokenTtlSecs?: number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// ---------------------------------------------------------------------------
//  MarketClient
// ---------------------------------------------------------------------------

export class MarketClient extends HttpBase {
  private readonly signerInput: SignerInput | null;
  private readonly bearer: string | null;
  /** Stored separately so bearer-mode callers can opt into `publicKey`
   *  for `getOwnIdentity()` without satisfying Sig-auth invariants. */
  private readonly knownAgentPubkey: string | null;
  private readonly tokenTtlSecs: number;
  private cached: CachedToken | null = null;

  constructor(cfg: MarketClientConfig = {}) {
    super(cfg);
    const a = cfg.agent;
    if (a) {
      const hasSigner = !!(a.secretKey || a.signer);
      const hasBearer = !!a.bearer;
      if (hasSigner && hasBearer) {
        throw new AvoSdkError({
          status: 500,
          code: 'AGENT_AUTH_AMBIGUOUS',
          message:
            'MarketClient: `agent` may carry EITHER signer credentials ' +
            '(`secretKey` / `signer`) OR `bearer`, not both. Pick one.',
        });
      }
      if (hasSigner) {
        if (!a.publicKey) {
          throw new AvoSdkError({
            status: 500,
            code: 'AGENT_PUBLIC_KEY_MISSING',
            message:
              'MarketClient: Sig-auth mode requires `agent.publicKey` so the ' +
              'SDK can mint tokens against the canonical message.',
          });
        }
        this.signerInput = {
          publicKey: a.publicKey,
          secretKey: a.secretKey,
          signer: a.signer,
        };
        this.bearer = null;
        this.knownAgentPubkey = bs58.encode(a.publicKey);
      } else if (hasBearer) {
        this.signerInput = null;
        this.bearer = a.bearer!;
        this.knownAgentPubkey = a.publicKey ? bs58.encode(a.publicKey) : null;
      } else {
        throw new AvoSdkError({
          status: 500,
          code: 'AGENT_AUTH_EMPTY',
          message:
            'MarketClient: `agent` was provided but carries neither ' +
            '`secretKey`/`signer` nor `bearer`.',
        });
      }
    } else {
      this.signerInput = null;
      this.bearer = null;
      this.knownAgentPubkey = null;
    }
    this.tokenTtlSecs = cfg.tokenTtlSecs ?? 600;
  }

  /** The configured agent's base58 pubkey, or `null` for unauthenticated
   *  clients and for bearer-mode clients that didn't pass `publicKey`. */
  get agentPubkey(): string | null {
    return this.knownAgentPubkey;
  }

  // -------------------------------------------------------------------------
  //  Bootstrap — no auth required
  // -------------------------------------------------------------------------

  /**
   * Phase 1 of permissionless market creation. The API generates a fresh
   * custodial agent keypair, stores the requested market params, and
   * returns an unsigned 0.1 SOL transfer (creator → agent). Sign + submit
   * the returned `fundingTx`, then call `finalizeCreateMarket`.
   *
   * After `finalizeCreateMarket` returns, the API holds the agent's
   * secret key encrypted at rest. You receive a one-time bearer token
   * but **never** the secret key. Use bearer mode (`agent: { bearer }`)
   * to drive subsequent agent ops.
   */
  prepareCreateMarket(body: PrepareCreateMarketBody): Promise<PrepareCreateMarketResp> {
    return this.callAvo('POST', '/v1/markets/create/prepare', { body, auth: false });
  }

  /**
   * Phase 2 of permissionless market creation. Verifies the funding
   * transfer landed, then the custodial agent signs `create_market` +
   * one `add_market_asset` per requested asset SERVER-SIDE. Returns the
   * marketPda + a one-time bearer.
   */
  finalizeCreateMarket(body: FinalizeCreateMarketBody): Promise<FinalizeCreateMarketResp> {
    return this.callAvo('POST', '/v1/markets/create/finalize', { body, auth: false });
  }

  /**
   * One-shot wrapper around `prepareCreateMarket` → operator-side
   * funding-tx signing → `finalizeCreateMarket`. Returns the same
   * `FinalizeCreateMarketResp` as a manual two-step flow.
   *
   * The API server registers a shadow portfolio in portfolio-service
   * as part of `finalizeCreateMarket` and seeds it with a first
   * rebalance — that's what makes the `/market/[pda]` chart and Tokens
   * tab populate without any additional client calls. **Everything
   * needed to get the chart working is set up by this single method.**
   *
   * The caller supplies a `signFundingTx` callback that takes the
   * base64-encoded unsigned `VersionedTransaction` from phase 1, signs
   * + submits it via the operator's wallet, and returns the Solana
   * signature. This SDK never touches the operator's signing material.
   *
   * Example with Dynamic's Solana adapter:
   * ```ts
   * await client.createMarketWithShadowPortfolio(body, async (txBase64) => {
   *   const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
   *   const result = await primaryWallet.signAndSendTransaction(tx);
   *   return typeof result === 'string' ? result : result.signature;
   * });
   * ```
   */
  async createMarketWithShadowPortfolio(
    body: PrepareCreateMarketBody,
    signFundingTx: (fundingTxBase64: string) => Promise<string>,
  ): Promise<FinalizeCreateMarketResp> {
    const prep = await this.prepareCreateMarket(body);
    const fundingSignature = await signFundingTx(prep.fundingTx);
    if (!fundingSignature || typeof fundingSignature !== 'string') {
      throw new AvoSdkError({
        status: 500,
        code: 'INVALID_FUNDING_SIGNATURE',
        message:
          'createMarketWithShadowPortfolio: signFundingTx must return a non-empty ' +
          'Solana tx signature string.',
      });
    }
    return this.finalizeCreateMarket({
      agentPubkey: prep.agentPubkey,
      fundingSignature,
    });
  }

  /**
   * Register an externally-created market with the API.
   *
   * Workflow: you created the market on chain yourself, and you hold
   * the agent secret key locally. Call this to hand the secret to the
   * API for custodial signing of subsequent agent ops. The API validates
   * the secret matches the on-chain `Market.agent` before encrypting +
   * storing.
   *
   * Returns a one-time bearer. The secret you sent in is encrypted at
   * rest and never echoed back. To rotate the bearer, re-register the
   * same market.
   */
  registerMarket(body: RegisterMarketBody): Promise<RegisterMarketResp> {
    return this.callAvo('POST', '/v1/markets/register', { body, auth: false });
  }

  // -------------------------------------------------------------------------
  //  Public reads — no auth required
  // -------------------------------------------------------------------------

  healthz(): Promise<HealthResp> {
    return this.callAvo('GET', '/healthz', { auth: false });
  }

  /** Paginated catalog of every registered market. */
  listMarkets(params: ListMarketsParams = {}): Promise<ListMarketsResp> {
    return this.callAvo('GET', '/v1/markets', {
      auth: false,
      query: { limit: params.limit, offset: params.offset },
    });
  }

  /** On-chain activity log for a market. Paged via `before = <oldest_signature>`
   *  from the previous response. */
  getMarketEvents(
    marketPda: string,
    params: GetMarketEventsParams = {},
  ): Promise<MarketEventsResp> {
    return this.callAvo('GET', `/v1/markets/${encodeURIComponent(marketPda)}/events`, {
      auth: false,
      query: { limit: params.limit, before: params.before },
    });
  }

  /** NAV time series for a market. */
  getNavHistory(
    marketPda: string,
    params: GetNavHistoryParams = {},
  ): Promise<NavHistoryResp> {
    const toIso = (d: string | Date | undefined): string | undefined =>
      d === undefined ? undefined : d instanceof Date ? d.toISOString() : d;
    return this.callAvo(
      'GET',
      `/v1/markets/${encodeURIComponent(marketPda)}/nav-history`,
      {
        auth: false,
        query: {
          limit: params.limit,
          order: params.order,
          from: toIso(params.from),
          to: toIso(params.to),
        },
      },
    );
  }

  /** Read any agent's MPL-8004 identity + cached reputation. */
  getIdentity(agentPubkey: string): Promise<AgentIdentityResp> {
    return this.callAvo(
      'GET',
      `/v1/agents/identity/${encodeURIComponent(agentPubkey)}`,
      { auth: false },
    );
  }

  /**
   * Attach an MPL-8004 Core NFT identity to a registered agent.
   *
   * Permissionless — anyone with the agent's keypair plus ownership of
   * the Core asset can attach. The API verifies:
   *   1. The supplied signature verifies against `agentPubkey` for the
   *      canonical attach message (use `buildAttachMessage` to construct it).
   *   2. The Core asset's on-chain owner equals `agentPubkey`.
   *   3. The Core asset's on-chain `uri` equals `agentUri` (anti-spoofing).
   *
   * Idempotent on `(agentPubkey, coreAssetAddress)` — re-attaching the
   * same pair refreshes `agentUri` only.
   */
  attachIdentity(body: AttachIdentityBody): Promise<AttachIdentityResp> {
    return this.callAvo('POST', '/v1/agents/identity/attach', {
      auth: false,
      body,
    });
  }

  // -------------------------------------------------------------------------
  //  Agent ops — authenticated (Sig or Bearer)
  // -------------------------------------------------------------------------

  /** Read the configured agent's own market. */
  getMarket(): Promise<MarketResp> {
    return this.callAvo('GET', '/v1/market');
  }

  /** Read the configured agent's registered MarketAssets. */
  getAssets(): Promise<AssetView[]> {
    return this.callAvo('GET', '/v1/assets');
  }

  /**
   * Live snapshot of every vault balance, each trade asset priced into
   * base via a Jupiter quote.
   */
  getValue(slippageBps?: number): Promise<ValueResp> {
    return this.callAvo('GET', '/v1/value', { query: { slippageBps } });
  }

  /** Jupiter quote passthrough. */
  getQuote(params: QuoteParams): Promise<QuoteResp> {
    return this.callAvo('GET', '/v1/quote', {
      query: {
        from: params.from,
        to: params.to,
        amount: typeof params.amount === 'bigint' ? params.amount.toString() : params.amount,
        slippageBps: params.slippageBps,
        onlyDirectRoutes: params.onlyDirectRoutes,
      },
    });
  }

  /** Push a fresh total-value into `Market.last_total_value`. */
  updateNav(body: NavBody = {}): Promise<NavResp> {
    return this.callAvo('POST', '/v1/nav', { body: this.serializeBody(body) });
  }

  /**
   * Drive a full rebalance (prepare → leg × N → settle). The API picks
   * routers, signs every tx as the agent, and submits.
   */
  rebalance(body: RebalanceBody): Promise<RebalanceResp> {
    return this.callAvo('POST', '/v1/rebalance', { body: this.serializeBody(body) });
  }

  /** Dry-run version of `rebalance` — same planning, no submission. */
  simulateRebalance(body: SimulateBody): Promise<SimulateResp> {
    return this.callAvo('POST', '/v1/rebalance/simulate', { body: this.serializeBody(body) });
  }

  /** Register a new MarketAsset (at 0% target weight). */
  addAsset(body: AddAssetBody): Promise<AddAssetResp> {
    return this.callAvo('POST', '/v1/assets', { body });
  }

  /**
   * Pull the accrued fees out of the market agent's fee ATA and land
   * them in a destination wallet. Same on-chain effect a manual SPL
   * `transfer` from the agent would produce — but the agent signs
   * server-side so operators never need to hold the agent's keys just
   * to reclaim fees.
   *
   * Idempotent — safe to call on a cron. Returns `signature: null` +
   * `amountWithdrawn: "0"` when the balance is already below
   * `minFeeAmount` (typically set to skip dust).
   */
  withdrawAgentFees(body: WithdrawAgentFeesBody): Promise<WithdrawAgentFeesResp> {
    return this.callAvo('POST', '/v1/agent/fees/withdraw', {
      body: this.serializeBody(body),
    });
  }

  /**
   * Remove a MarketAsset — liquidates its vault to base via Jupiter and
   * closes the vault + market-asset accounts.
   */
  removeAsset(mint: string, opts: RemoveAssetOpts = {}): Promise<RemoveAssetResp> {
    return this.callAvo('DELETE', `/v1/assets/${encodeURIComponent(mint)}`, {
      query: { slippageBps: opts.slippageBps, deadlineSecs: opts.deadlineSecs },
    });
  }

  /** Read the configured agent's own MPL-8004 identity. Requires the
   *  client to know its pubkey — Sig mode always does; bearer mode only
   *  when `publicKey` was passed at construction. */
  async getOwnIdentity(): Promise<AgentIdentityResp> {
    if (!this.knownAgentPubkey) {
      throw this.notConfiguredError(
        'getOwnIdentity (pass `agent.publicKey` if you constructed with bearer-only auth)',
      );
    }
    return this.getIdentity(this.knownAgentPubkey);
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  /** Recursively coerce bigint fields → decimal strings (JSON has no bigint). */
  private serializeBody(body: unknown): unknown {
    if (body === null || typeof body !== 'object') return body;
    if (Array.isArray(body)) return body.map((b) => this.serializeBody(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = typeof v === 'bigint' ? v.toString() : this.serializeBody(v);
    }
    return out;
  }

  /** Build the `Authorization` header value for an authenticated call.
   *  Sig-auth mints + caches a token; bearer-auth stamps the static token. */
  private async getAuthorizationHeader(): Promise<string> {
    if (this.bearer) {
      return `Bearer ${this.bearer}`;
    }
    if (!this.signerInput) {
      throw this.notConfiguredError('auth');
    }
    const refreshThresholdMs = 30_000;
    if (this.cached && this.cached.expiresAtMs - Date.now() > refreshThresholdMs) {
      return `Sig ${this.cached.token}`;
    }
    const minted = await mintAuthToken(this.signerInput, this.tokenTtlSecs);
    this.cached = minted;
    return `Sig ${minted.token}`;
  }

  private notConfiguredError(forWhat: string): AvoSdkError {
    return new AvoSdkError({
      status: 500,
      code: 'AGENT_NOT_CONFIGURED',
      message:
        `MarketClient: ${forWhat} requires an \`agent\` in the constructor ` +
        '(`bearer`, or `publicKey` + `secretKey` / `signer`).',
    });
  }

  private async callAvo<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      body?: unknown;
      auth?: boolean;
      query?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false) {
      headers['authorization'] = await this.getAuthorizationHeader();
    }
    return this.requestService<T>({
      baseUrl: this.services.avoApi,
      method,
      path,
      body: opts.body,
      headers,
      query: opts.query,
    });
  }
}
