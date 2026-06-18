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
  services: { avoApi: 'https://api.avo.so' },
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
  services: { avoApi: 'https://api.avo.so' },
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
import { MarketClient } from '@avodotso/market-sdk';
import { VersionedTransaction } from '@solana/web3.js';

const client = new MarketClient({ services: { avoApi: 'https://api.avo.so' } });

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

// Phase 2: API verifies funding, custodial agent signs `create_market`
// on chain, weight-set rebalance lands the initial weights atomically.
const result = await client.finalizeCreateMarket({
  agentPubkey: prep.agentPubkey,
  fundingSignature: fundingSig,
});

console.log({
  marketPda: result.marketPda,
  agentPubkey: result.agentPubkey,
  bearer: result.bearer, // STORE NOW — shown ONCE
});
```

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
| `finalizeCreateMarket(body)` | `POST /v1/markets/create/finalize` | Returns marketPda + one-time bearer. |
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
  services: { avoApi: 'https://api.avo.so' },
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
  avoApi: 'https://api.avo.so',
});

const client = new MarketClient({ services });
```

You can pass a custom `fetch` for testing or instrumentation:

```ts
new MarketClient({
  services: { avoApi: 'https://api.avo.so' },
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
