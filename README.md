# `@avodotso/market-sdk`

TypeScript client for the [Avo Portfolio](https://avo.so) API on Solana. Built for market-makers: bootstrap an agent, run rebalances, push NAV updates — over plain HTTP, with one client class.

```bash
npm install @avodotso/market-sdk
# or
yarn add @avodotso/market-sdk
```

The SDK exports one primary class — `MarketClient` — that covers the entire market-maker journey: create → operate → close. No internal-only services, no chain-side ix builders, just the public HTTP API.

---

## Quickstart

### Operate a market (custodial — recommended)

You hold a bearer token (returned from `finalizeCreateMarket` or `registerMarket`); the API holds the agent's signing keypair encrypted at rest. **You never touch a private key.**

```ts
import { MarketClient } from '@avodotso/market-sdk';

const client = new MarketClient({
  services: { avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app' },
  agent: { bearer: process.env.AGENT_BEARER! },
});

// Live valuation of every vault in the market.
const value = await client.getValue(/* slippageBps = */ 50);

// Rebalance to a new target weight vector (asset mint → percent; sum = 100).
await client.rebalance({
  weights: [
    { asset: 'base', weight: 0 },
    { asset: 'So11111111111111111111111111111111111111112', weight: 50 },
    { asset: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', weight: 50 },
  ],
  slippageBps: 100,
  deadlineSecs: 180,
});

// Push fresh NAV onto chain.
await client.updateNav();
```

### Operate a market (self-custodial — Sig auth)

You hold the agent's 64-byte Ed25519 secret key yourself; the SDK mints fresh signed tokens on every call window.

```ts
import { MarketClient } from '@avodotso/market-sdk';
import { Keypair } from '@solana/web3.js';

const agentKp = Keypair.fromSecretKey(/* your agent's 64-byte secret key */);

const client = new MarketClient({
  services: { avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app' },
  agent: {
    publicKey: agentKp.publicKey.toBytes(),
    secretKey: agentKp.secretKey,
  },
});

await client.rebalance({ /* ... */ });
```

External signers (KMS / hardware wallet / Turnkey) are supported via `agent.signer` — see [Auth model](#auth-model) below.

### Create a new market (permissionless flow)

The API generates a fresh agent keypair custodially. You sign the funding tx with your operator wallet; the API does the rest. You get back a one-time bearer for ongoing ops.

```ts
import { MarketClient, buildCreatorAuth } from '@avodotso/market-sdk';
import { VersionedTransaction } from '@solana/web3.js';

const client = new MarketClient({ services: { avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app' } });

// Phase 1: register intent + receive an unsigned 0.1 SOL funding tx.
const prep = await client.prepareCreateMarket({
  creator: myWallet.publicKey.toBase58(),
  baseAssetMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mainnet
  feeAssetMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  marketFeeBps: 30,
  label: 'My Index',
  assetMints: ['So11111111111111111111111111111111111111112'],
  initialWeights: { base: 0, So11111111111111111111111111111111111111112: 10_000 },
});

// Phase 1b: your wallet signs + submits the funding transfer.
const tx = VersionedTransaction.deserialize(Buffer.from(prep.fundingTx, 'base64'));
const fundingSig = await myWallet.signAndSendTransaction(tx);

// Phase 2: the same wallet signs a short-lived, single-use creatorAuth that
// binds this pending market, its agent and the funding tx. Finalize is
// refused without it.
const { creatorAuth } = await buildCreatorAuth({
  creator: myWallet.publicKey.toBase58(),
  pendingId: prep.pendingId,
  agentPubkey: prep.agentPubkey,
  fundingSignature: fundingSig,
  signMessage: (msg) => myWallet.signMessage(msg), // or `secretKey: creatorKp.secretKey`
});

// API verifies creatorAuth + funding, custodial agent signs `create_market`
// on chain, weight-set rebalance lands the initial weights atomically.
const result = await client.finalizeCreateMarket({
  agentPubkey: prep.agentPubkey,
  fundingSignature: fundingSig,
  creatorAuth,
});

console.log({
  marketPda: result.marketPda,
  agentPubkey: result.agentPubkey,
  bearer: result.bearer, // STORE NOW — shown ONCE
});
```

`creatorAuth` is valid for at most 110 seconds (default 60) and its nonce is single-use, so build a new one for every finalize attempt, including retries after a retryable `FUNDING_TX_NOT_FOUND` (honour `Retry-After`). Errors: `CREATOR_AUTH_REQUIRED`, `CREATOR_MISMATCH`, `CREATOR_AUTH_REPLAYED`, `FUNDING_*`.

One call does all of the above:

```ts
const result = await client.createMarketWithShadowPortfolio(
  body,
  async (fundingTxBase64) => myWallet.signAndSendTransaction(
    VersionedTransaction.deserialize(Buffer.from(fundingTxBase64, 'base64')),
  ),
  (msg) => myWallet.signMessage(msg),
);
```

**Upgrading from 0.2.x:** `finalizeCreateMarket` now requires `creatorAuth`, and `createMarketWithShadowPortfolio` takes a required third `signMessage` argument. Both must be signed by `body.creator`.

### Register a market you built on-chain yourself

You generated the agent keypair locally, built + submitted `create_market` on chain via Anchor, and want the API to hold the keypair for custodial signing of subsequent ops. The API validates the secret matches the on-chain `Market.agent` before encrypting + storing.

```ts
import bs58 from 'bs58';

const result = await client.registerMarket({
  marketPda: myMarketPda.toBase58(),
  agentSecretBase58: bs58.encode(agentKp.secretKey),
  label: 'My Self-Custody Market',
});
// Same shape: one-time bearer for the custodial path going forward.
```

---

## Method reference

### Bootstrap (no auth)

| Method | Endpoint | Notes |
|---|---|---|
| `prepareCreateMarket(body)` | `POST /v1/markets/create/prepare` | Returns an unsigned funding tx. |
| `finalizeCreateMarket(body)` | `POST /v1/markets/create/finalize` | Requires `creatorAuth` from `buildCreatorAuth`. Returns marketPda + one-time bearer. |
| `createMarketWithShadowPortfolio(body, signFundingTx, signMessage)` | prepare → fund → finalize | One-shot create; both callbacks use the `body.creator` wallet. |
| `registerMarket(body)` | `POST /v1/markets/register` | For markets you created on chain yourself. |

### Public reads (no auth)

| Method | Endpoint | Notes |
|---|---|---|
| `healthz()` | `GET /healthz` | API liveness. |
| `listMarkets({ limit, offset })` | `GET /v1/markets` | Paginated catalog. |
| `getMarketEvents(pda, { limit, before })` | `GET /v1/markets/{pda}/events` | On-chain activity log; paged via `before` cursor. |
| `getNavHistory(pda, { limit, order, from, to })` | `GET /v1/markets/{pda}/nav-history` | NAV time series. `from`/`to` accept `Date` or ISO string. |
| `getIdentity(agentPubkey)` | `GET /v1/agents/identity/{pubkey}` | MPL-8004 identity + reputation. |
| `attachIdentity(body)` | `POST /v1/agents/identity/attach` | Attach a Core NFT identity (signature-gated, permissionless). |

### Agent ops (authenticated — requires `agent` in constructor)

| Method | Endpoint | Notes |
|---|---|---|
| `getMarket()` | `GET /v1/market` | The configured agent's market. |
| `getAssets()` | `GET /v1/assets` | Registered MarketAssets. |
| `getValue(slippageBps?)` | `GET /v1/value` | Live NAV via Jupiter quotes. |
| `getQuote(params)` | `GET /v1/quote` | Jupiter quote passthrough. |
| `updateNav(body?)` | `POST /v1/nav` | Push fresh `last_total_value`. |
| `rebalance(body)` | `POST /v1/rebalance` | Custodial prepare → leg × N → settle. |
| `simulateRebalance(body)` | `POST /v1/rebalance/simulate` | Dry-run. |
| `addAsset(body)` | `POST /v1/assets` | Register a MarketAsset at 0% weight. |
| `removeAsset(mint, opts?)` | `DELETE /v1/assets/{mint}` | Liquidate + close the vault. |
| `getOwnIdentity()` | `GET /v1/agents/identity/{self}` | Self-lookup wrapper. |

---

## Auth model

`MarketClient` agent-op methods support two auth modes. **Both produce identical access to the same agent identity** — they just differ in where the signing material lives.

### Bearer (custodial)

The agent's secret key stays encrypted inside the API. You only hold the one-time bearer returned by `finalizeCreateMarket` / `registerMarket`. **Recommended default** for hosted market-makers — no key management on your side, and the bearer is a single short string you can rotate by re-registering the market.

```ts
new MarketClient({
  services: { avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app' },
  agent: {
    bearer: 'mb_8e3f…',                // stored from finalizeCreateMarket
    publicKey: kp.publicKey.toBytes(), // optional; enables getOwnIdentity()
  },
});
```

Stamps `Authorization: Bearer <token>` on every agent-op call. The API hashes the token at receipt (`sha256`) and matches it against the `bearerHash` it stored at registration. No TTL — valid until you rotate or get the agent revoked.

**Threat model.** A leaked bearer is equivalent operational power to a leaked secret key *against the API*: the attacker can rebalance / update NAV / add or remove assets as your agent. But the blast radius is bounded relative to the keypair:

- The bearer **cannot sign on-chain transactions outside our API** — it's not a Solana keypair.
- The bearer **cannot withdraw the agent's keypair** — that material never leaves the API's at-rest encryption.
- Rotation is one HTTP call: re-register the same market.

### Sig (self-custodial)

You hold the Ed25519 secret key yourself; the SDK mints a short-lived signed token over a canonical message:

```
avo-portfolio-api/v1
<agent pubkey base58>
<expiresAt unix milliseconds>
```

In-process secret:

```ts
new MarketClient({
  agent: {
    publicKey: kp.publicKey.toBytes(),
    secretKey: kp.secretKey,
  },
});
```

External signer (KMS / hardware wallet / Turnkey):

```ts
new MarketClient({
  agent: {
    publicKey: kp.publicKey.toBytes(),
    signer: async (message: Uint8Array) => {
      return await myExternalSigner.sign(message); // returns 64-byte Ed25519 sig
    },
  },
});
```

Tokens are minted lazily and cached until ~30 s before expiry. TTL defaults to **600 s** (10 min); override with `tokenTtlSecs` on the constructor. The API caps TTL at its own `MAX_AUTH_TTL_SECS`, so over-long TTLs are clamped server-side.

For minting tokens outside the SDK (e.g. server-side verifying its own auth):

```ts
import { canonicalAuthMessage, mintAuthToken } from '@avodotso/market-sdk';

const { token, expiresAtMs } = await mintAuthToken({
  publicKey: kp.publicKey.toBytes(),
  secretKey: kp.secretKey,
}, /* ttlSecs = */ 600);
```

### Picking between them

- **Just did `prepareCreateMarket` + `finalizeCreateMarket`?** Use bearer — you don't have the keypair (the API does).
- **Built your market on-chain yourself + called `registerMarket`?** Either works. Sig is more self-custodial; bearer is simpler.
- **Operating someone else's market on their behalf?** Whichever credential they handed you. Bearers are easier to scope-down and rotate.

---

## Config

`MarketClient` reads the API base URL from `AvoServiceConfig`. Just one slot:

```ts
import { resolveServiceConfig } from '@avodotso/market-sdk';

const services = resolveServiceConfig({
  avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app',
});

const client = new MarketClient({ services });
```

You can pass a custom `fetch` for testing or instrumentation:

```ts
new MarketClient({
  services: { avoApi: 'https://portfolio-contract-api-service-dev.up.railway.app' },
  fetch: myInstrumentedFetch,
});
```

---

## Errors

Every HTTP failure throws `AvoSdkError`. Network failures (DNS / connection refused / non-JSON body) throw `AvoTransportError`.

```ts
import { AvoSdkError, AvoTransportError } from '@avodotso/market-sdk';

try {
  await client.rebalance({ /* ... */ });
} catch (err) {
  if (err instanceof AvoSdkError) {
    console.error(err.status, err.code, err.message, err.details);
  } else if (err instanceof AvoTransportError) {
    console.error('network failure:', err.message);
  } else {
    throw err;
  }
}
```

`AvoSdkError` codes the SDK itself raises:

| Code | When |
|---|---|
| `SERVICE_UNCONFIGURED` | No `services.avoApi` was set. |
| `AGENT_NOT_CONFIGURED` | A protected method was called on an unauthenticated client (or `getOwnIdentity` in bearer mode without `publicKey`). |
| `AGENT_AUTH_AMBIGUOUS` | Constructor got both signer credentials and a bearer. |
| `AGENT_PUBLIC_KEY_MISSING` | Sig mode constructor without `publicKey`. |
| `AGENT_AUTH_EMPTY` | Constructor got `agent: {}` with no auth material. |
| `HTTP_<status>` | API returned a non-2xx with no parseable error envelope. |

All other `code` values come straight from the API's error envelope.

---

## Versioning

Semver. Anything documented above is stable.

## License

ISC. See `LICENSE`.


## Service compatibility (0.2.1)

Pin `@avodotso/market-sdk` to **`0.2.1`** in worker dependencies and regenerate
locks after that version is published. Do not use `latest` for scheduled workers.
This package publishes to public npm; `@avodotso/portfolio-internal` is a separate
service-side package with program-deployment constraints.

For a gateway URL, supply the gateway's full Authorization header independently
of the market agent credential:

```ts
const client = new MarketClient({
  services: { avoApi: 'https://dev-avo-fe-api.up.railway.app' },
  gatewayAuthorization: async () => getGatewayAuthorization(),
  agent: { bearer: agentBearer },
});
```

`getGatewayAuthorization` is your credential provider (returning, for example,
`Bearer <gateway token>`). The SDK sends it in `Authorization` and sends agent
auth in `x-avo-agent-authorization`. The callback runs per request so expiring
credentials can refresh. Public reads omit agent auth. Direct market-service
clients omit `gatewayAuthorization` and retain the existing header behavior.
Never log either credential. The old standalone
`portfolio-contract-api-service-dev.up.railway.app` URL is no longer a working
service endpoint.

`rebalance()` invokes the server's prepare → swap legs → settle orchestration;
the service builds, signs and submits transactions. Sig authentication proves
API identity; it does not turn this endpoint into an unsigned transaction
builder. There are no separate build, sign, submit or settle methods in this
HTTP SDK. `updateNav()` also signs and submits on the server.

For read-only validation use `getQuote()`, `getValue()` and
`simulateRebalance()`. The last method plans and quotes; it does **not** run
Solana transaction simulation or validate settlement. Reject unroutable legs
(`unroutable`, `unroutableReason`) and independently check execution loss.
`estimatedTotalValueAfterBase` deducts estimated fees; it is not proof of a
maximum market-impact loss. Slippage of 200 bps alone does not prove a 2% loss
limit against a reference value.

Keep `onlyDirectRoutes` false or omitted for assets requiring multiple hops.
Rebalance accepts `excludeDexes` (for example `Scorch`), `feeSlippageBps`,
`dustThresholdBps`, `acceptLowAumTopup` and `progressId`. The simulation endpoint
accepts dust thresholds but does not exercise the rebalance router filters or
fee-conversion swaps. Router-filter serialization is not proof of enforcement:
market-service deployment `541e307e` accepts these fields but does not forward
them from its execution service to the orchestrator. Its dFlow adapter already statically excludes Scorch, but workers must verify
that protection in route evidence; arbitrary caller filters need backend
forwarding before they can be relied upon.
`dustThresholdBase` takes precedence over bps. Server dust
defaults vary by market; pass an explicit value when comparing preview and run.

A failed rebalance may arrive as HTTP 200 after keepalive whitespace, containing
`__rebalanceError`. Version 0.2.1 throws `AvoSdkError` with its status, code,
message and details. There is no automatic retry: execution may already be
partially applied. Inspect the market/plan before retrying. Successful
`driftAutoSuccess` responses can have empty signatures when existing weights
are already acceptable; they do not mean new transactions landed.
