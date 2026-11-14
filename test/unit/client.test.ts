/**
 * Unit tests for `MarketClient`.
 *
 * Strategy:
 *   • Inject a fake `fetch` via `MarketClientConfig.fetch`. Each test
 *     asserts the URL, method, headers, and body the client produces.
 *   • Sig-token minting is exercised end-to-end with a real keypair —
 *     `nacl.sign.detached` is fast (~ms) and verifies the auth header
 *     is produced in the exact format the API verifier expects.
 *   • No live network. No external dependencies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  MarketClient,
  AvoSdkError,
  AvoTransportError,
  buildAttachMessage,
  canonicalRequestTarget,
  mintRequestSig,
} from '../../src/index';
import { createHash } from 'node:crypto';

/** Pinned in market-service and portfolio-internal tests too. */
// Derived from market-service's own bodyBoundSigMessage/requestScope (seed 0x07*32,
// POST /v1/markets/bearer/rotate?b=2&a=1, body {"marketPda":"M"}, nonce golden-nonce-0123456789,
// now 1.8e12, TTL 60 s). The same string is pinned in market-service
// test/unit/sig2-binding-bearer-rotation.test.ts and the other SDK's tests; change all three together.
const GOLDEN_SIG2 =
  'Sig2 GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB.1800000060000.golden-nonce-0123456789.f1d47fff107d7b5a1e8121b5322171dc5fe93775b82cbc8feac48b36183ae88e.2kiojno4SWR3UXv2C1ix3HLY3VDN2ycw4jXKmw7Vjjw4a9pnU6hiEGXN2Xj9jd4Tc6yRRL4xe2CaL3VpN3oMvwAY';

const AVO_API = 'https://avo-api.test';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(responder: (req: CapturedRequest) => Promise<Response> | Response): {
  fn: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const bodyRaw = init?.body;
    let body: unknown = undefined;
    if (typeof bodyRaw === 'string') {
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        body = bodyRaw;
      }
    }
    const req = { url, method, headers, body };
    requests.push(req);
    return responder(req);
  };
  return { fn, requests };
}

function makeAgent() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    pubkeyBase58: bs58.encode(kp.publicKey),
  };
}

describe('MarketClient — unauthenticated mode', () => {
  it('exposes agentPubkey === null when no agent is configured', () => {
    const client = new MarketClient({ services: { avoApi: AVO_API } });
    expect(client.agentPubkey).toBeNull();
  });

  it('calls /healthz without an Authorization header', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({ ok: true }));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await client.healthz();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${AVO_API}/healthz`);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it('throws AGENT_NOT_CONFIGURED when calling a Sig-authed method', async () => {
    const client = new MarketClient({ services: { avoApi: AVO_API } });
    await expect(client.getMarket()).rejects.toMatchObject({
      code: 'AGENT_NOT_CONFIGURED',
      status: 500,
    });
  });

  it('throws AGENT_NOT_CONFIGURED on getOwnIdentity without an agent', async () => {
    const client = new MarketClient({ services: { avoApi: AVO_API } });
    await expect(client.getOwnIdentity()).rejects.toMatchObject({
      code: 'AGENT_NOT_CONFIGURED',
    });
  });

  it('throws SERVICE_UNCONFIGURED when avoApi URL is empty', async () => {
    const client = new MarketClient({ services: { avoApi: '' } });
    await expect(client.healthz()).rejects.toMatchObject({
      code: 'SERVICE_UNCONFIGURED',
      status: 500,
    });
  });
});

describe('MarketClient — bootstrap endpoints (no auth)', () => {
  it('POSTs /v1/markets/create/prepare with the body verbatim', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({
        pendingId: 'pending_1',
        agentPubkey: 'GbGgT4qSpooM6f1cgFD3Q63oZcMpkkE4dZgEjs83JM7M',
        fundingLamports: 100_000_000,
        fundingTx: 'b64-encoded-tx',
        nextStep: 'sign + submit fundingTx',
      }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    const resp = await client.prepareCreateMarket({
      creator: 'CreatorPubkey',
      baseAssetMint: 'BaseMint',
      feeAssetMint: 'FeeMint',
      marketFeeBps: 30,
      assetMints: ['Asset1'],
      initialWeights: { base: 0, Asset1: 10_000 },
    });
    expect(resp.fundingTx).toBe('b64-encoded-tx');
    expect(requests[0].url).toBe(`${AVO_API}/v1/markets/create/prepare`);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].headers['content-type']).toBe('application/json');
    expect(requests[0].body).toMatchObject({
      creator: 'CreatorPubkey',
      marketFeeBps: 30,
      initialWeights: { base: 0, Asset1: 10_000 },
    });
  });

  it('POSTs /v1/markets/register without auth', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({
        agentId: 'a',
        marketId: 'm',
        marketPda: 'pda',
        marketIndex: 0,
        agentPubkey: 'pk',
        bearer: 'BEARER',
        bearerHashHex: 'h',
      }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    const resp = await client.registerMarket({
      marketPda: 'somePda',
      agentSecretBase58: 'someSecret',
    });
    expect(resp.bearer).toBe('BEARER');
    expect(requests[0].url).toBe(`${AVO_API}/v1/markets/register`);
    expect(requests[0].headers.authorization).toBeUndefined();
  });
});

describe('MarketClient — request-bound Sig2 auth', () => {
  let agent: ReturnType<typeof makeAgent>;
  beforeEach(() => {
    agent = makeAgent();
  });

  /** Captures the exact body string sent, so the signed hash can be checked against it. */
  function rawFetch() {
    const sent: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    const fn: typeof fetch = async (input, init) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      sent.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return jsonResponse({});
    };
    return { fn, sent };
  }

  /** Restated API verifier (market-service `verifyScopedSig`, v3 branch). */
  function verifiesFor(header: string, req: { method: string; url: string; body: string }, pk: Uint8Array): boolean {
    const m = /^Sig2 (.+)$/.exec(header);
    if (!m) return false;
    const [pubkey, exp, nonce, hash, sig] = m[1].split('.');
    const u = new URL(req.url);
    u.searchParams.sort();
    const q = u.searchParams.toString();
    const target = u.pathname + (q ? `?${q}` : '');
    const bodyHash = createHash('sha256').update(req.body).digest('hex');
    if (hash !== bodyHash) return false;
    const msg = Buffer.from(
      `avo-portfolio-api/v3\n${pubkey}\n${exp}\n${nonce}\n${req.method}\n${target}\n${bodyHash}`,
      'utf8',
    );
    return nacl.sign.detached.verify(msg, bs58.decode(sig), pk);
  }

  it('signs each agent request with a fresh Sig2 bound to its method, path, query and exact body', async () => {
    const { fn, sent } = rawFetch();
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
    await client.getMarket();
    await client.getValue(50);
    await client.updateNav({ totalValueBase: 123n } as never);
    expect(sent).toHaveLength(3);
    for (const req of sent) {
      expect(req.headers.authorization.startsWith(`Sig2 ${agent.pubkeyBase58}.`)).toBe(true);
      expect(verifiesFor(req.headers.authorization, req, agent.publicKey)).toBe(true);
    }
    const nonces = sent.map((r) => r.headers.authorization.split('.')[2]);
    expect(new Set(nonces).size).toBe(3);
    expect(verifiesFor(sent[0].headers.authorization, sent[1], agent.publicKey)).toBe(false);
    expect(verifiesFor(sent[2].headers.authorization, { ...sent[2], body: sent[2].body + ' ' }, agent.publicKey)).toBe(false);
  });

  it('keeps the Sig2 lifetime within the API ceiling (default 60 s, capped at 120 s)', async () => {
    const { fn, sent } = rawFetch();
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
      tokenTtlSecs: 3600,
    });
    const before = Date.now();
    await client.getMarket();
    const exp = Number(sent[0].headers.authorization.split('.')[1]);
    expect(exp).toBeGreaterThan(before);
    expect(exp - before).toBeLessThanOrEqual(121_000);
  });

  it('hands an external signer the Sig2 message for the request', async () => {
    const { fn, sent } = rawFetch();
    const signer = vi.fn(async (msg: Uint8Array) => nacl.sign.detached(msg, agent.secretKey));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, signer },
    });
    await client.getMarket();
    expect(signer).toHaveBeenCalledTimes(1);
    const text = new TextDecoder().decode(signer.mock.calls[0][0] as Uint8Array);
    expect(text.startsWith(`avo-portfolio-api/v3\n${agent.pubkeyBase58}\n`)).toBe(true);
    expect(text).toContain('\nGET\n/v1/market\n');
    expect(verifiesFor(sent[0].headers.authorization, sent[0], agent.publicKey)).toBe(true);
  });

  it('through the gateway, the Sig2 rides in x-avo-agent-authorization and binds the same request', async () => {
    const { fn, sent } = rawFetch();
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      gatewayAuthorization: 'Bearer gateway',
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
    await client.rebalance({ weights: [{ asset: 'base', weightBps: 10000 }] } as never);
    expect(sent[0].headers.authorization).toBe('Bearer gateway');
    expect(verifiesFor(sent[0].headers['x-avo-agent-authorization'], sent[0], agent.publicKey)).toBe(true);
  });

  it.each(['transport', 'unauthorized'] as const)('signs a caller retry after %s without replaying or downgrading credentials', async (failure) => {
    const { fn, sent } = rawFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      await fn(input, init);
      if (sent.length === 1) {
        if (failure === 'transport') throw new Error('connection lost');
        return jsonResponse({ error: { code: 'BAD_AUTH', message: 'refused' } }, 401);
      }
      return jsonResponse({});
    };
    const client = new MarketClient({
      services: { avoApi: AVO_API }, fetch: fetchImpl,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
    const operation = { weights: [{ asset: 'base', weightBps: 10000 }], progressId: 'same-operation' };
    await expect(client.rebalance(operation)).rejects.toThrow();
    expect(sent).toHaveLength(1); // No automatic retry of a possibly applied write.
    await client.rebalance(operation);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toBe(sent[0].body);
    expect(sent[1].url).toBe(sent[0].url);
    const credentials = sent.map(req => req.headers.authorization);
    expect(credentials[1].split('.')[2]).not.toBe(credentials[0].split('.')[2]);
    for (const req of sent) expect(verifiesFor(req.headers.authorization, req, agent.publicKey)).toBe(true);
  });

  it('signs concurrent identical reads independently instead of sharing a cached nonce', async () => {
    const { fn, sent } = rawFetch();
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey } });
    await Promise.all(Array.from({ length: 8 }, () => client.getMarket()));
    expect(new Set(sent.map(req => req.headers.authorization.split('.')[2])).size).toBe(8);
    for (const req of sent) expect(verifiesFor(req.headers.authorization, req, agent.publicKey)).toBe(true);
  });

  it('refuses automatic redirects so signed credentials cannot be replayed by fetch', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect refused');
    });
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fetchImpl,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey } });
    await expect(client.getMarket()).rejects.toBeInstanceOf(AvoTransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not send a request when the external signer fails', async () => {
    const { fn, sent } = rawFetch();
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { publicKey: agent.publicKey, signer: async () => { throw new Error('signing unavailable'); } } });
    await expect(client.getMarket()).rejects.toThrow('signing unavailable');
    expect(sent).toHaveLength(0);
  });
});

describe('mintRequestSig golden vector (shared with market-service and portfolio-internal)', () => {
  it('produces the exact header the API verifier is pinned to', async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const header = await mintRequestSig(
      { publicKey: kp.publicKey, secretKey: kp.secretKey },
      { method: 'post', url: 'https://x.test/v1/markets/bearer/rotate?b=2&a=1', body: '{"marketPda":"M"}' },
      { nonce: 'golden-nonce-0123456789', now: 1_800_000_000_000, ttlSecs: 60 },
    );
    expect(header).toBe(GOLDEN_SIG2);
  });

  it('canonicalRequestTarget sorts the query like the API', () => {
    expect(canonicalRequestTarget('https://x.test/v1/value?slippageBps=5&a=b')).toBe('/v1/value?a=b&slippageBps=5');
    expect(canonicalRequestTarget('/v1/market')).toBe('/v1/market');
  });

  it('refuses a TTL above the API ceiling and a malformed nonce', async () => {
    const kp = nacl.sign.keyPair();
    const input = { publicKey: kp.publicKey, secretKey: kp.secretKey };
    await expect(mintRequestSig(input, { method: 'GET', url: '/v1/market' }, { ttlSecs: 121 })).rejects.toThrow(/ttlSecs/);
    await expect(mintRequestSig(input, { method: 'GET', url: '/v1/market' }, { nonce: 'short' })).rejects.toThrow(/nonce/);
  });
});

describe('MarketClient — agent ops', () => {
  let agent: ReturnType<typeof makeAgent>;
  let client: MarketClient;
  let requests: CapturedRequest[];

  beforeEach(() => {
    agent = makeAgent();
    const captured = captureFetch(() => jsonResponse({}));
    requests = captured.requests;
    client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: captured.fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
  });

  it('GET /v1/value passes slippageBps through the query string', async () => {
    await client.getValue(123);
    expect(requests[0].url).toBe(`${AVO_API}/v1/value?slippageBps=123`);
  });

  it('GET /v1/quote serializes bigint amounts as decimal strings', async () => {
    await client.getQuote({
      from: 'FromMint',
      to: 'ToMint',
      amount: 123456789n,
      slippageBps: 50,
    });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/v1/quote');
    expect(url.searchParams.get('amount')).toBe('123456789');
    expect(url.searchParams.get('slippageBps')).toBe('50');
  });

  it('POST /v1/rebalance serializes bigint fields in the body', async () => {
    await client.rebalance({
      weights: [{ asset: 'base', weight: 5000 }],
      slippageBps: 100,
      deadlineSecs: 180,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extraBigint: 9999999999999999n as any,
    } as any);
    const body = requests[0].body as Record<string, unknown>;
    expect(body.weights).toEqual([{ asset: 'base', weight: 5000 }]);
    expect(body.extraBigint).toBe('9999999999999999');
  });

  it('DELETE /v1/assets/:mint encodes the mint and forwards opts', async () => {
    await client.removeAsset('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', {
      slippageBps: 200,
      deadlineSecs: 120,
    });
    const url = new URL(requests[0].url);
    expect(requests[0].method).toBe('DELETE');
    expect(url.pathname).toBe(
      '/v1/assets/XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    );
    expect(url.searchParams.get('slippageBps')).toBe('200');
    expect(url.searchParams.get('deadlineSecs')).toBe('120');
  });

  it('getOwnIdentity hits /v1/agents/identity/<self> without Sig auth', async () => {
    await client.getOwnIdentity();
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe(`/v1/agents/identity/${agent.pubkeyBase58}`);
    expect(requests[0].headers.authorization).toBeUndefined();
  });
});

describe('MarketClient — public reads', () => {
  it('GET /v1/markets passes limit + offset', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({ markets: [], limit: 25, offset: 0, total: 0 }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await client.listMarkets({ limit: 25, offset: 50 });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/v1/markets');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  it('GET /v1/markets passes the listing filters and omits unset ones', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({ markets: [], limit: 50, offset: 0, total: 0 }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await client.listMarkets({ includeClosed: true, sort: 'popular', marketPda: 'PDA' });
    const url = new URL(requests[0].url);
    expect(url.searchParams.get('includeClosed')).toBe('true');
    expect(url.searchParams.get('sort')).toBe('popular');
    expect(url.searchParams.get('marketPda')).toBe('PDA');
    expect(url.searchParams.has('portfolioServiceId')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('GET /v1/markets/:pda/events accepts a `before` cursor', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({ events: [], oldest: null }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await client.getMarketEvents('PDA', { limit: 50, before: 'sig123' });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/v1/markets/PDA/events');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('before')).toBe('sig123');
  });

  it('GET /v1/markets/:pda/nav-history serializes Date params to ISO', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({
        marketPda: 'PDA',
        points: [],
        limit: 500,
        order: 'desc',
        from: null,
        to: null,
      }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    const from = new Date('2026-01-01T00:00:00Z');
    await client.getNavHistory('PDA', { order: 'asc', limit: 100, from });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/v1/markets/PDA/nav-history');
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('limit')).toBe('100');
  });
});

describe('MarketClient — Bearer auth (custodial mode)', () => {
  it('sets Authorization: Bearer <token> on agent-op calls', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { bearer: 'sk-secret-token' },
    });
    await client.getMarket();
    expect(requests[0].headers.authorization).toBe('Bearer sk-secret-token');
  });

  it('does not mint a signature when in bearer mode', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { bearer: 'tok' },
    });
    await client.getMarket();
    await client.getAssets();
    const auths = requests.map((r) => r.headers.authorization);
    expect(auths).toEqual(['Bearer tok', 'Bearer tok']);
  });

  it('agentPubkey is null in bearer mode when no publicKey is passed', () => {
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      agent: { bearer: 'tok' },
    });
    expect(client.agentPubkey).toBeNull();
  });

  it('agentPubkey resolves when bearer mode is paired with publicKey', () => {
    const agent = makeAgent();
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      agent: { bearer: 'tok', publicKey: agent.publicKey },
    });
    expect(client.agentPubkey).toBe(agent.pubkeyBase58);
  });

  it('getOwnIdentity works in bearer mode iff publicKey was supplied', async () => {
    const agent = makeAgent();
    const { fn, requests } = captureFetch(() =>
      jsonResponse({ identity: null, rating: null }),
    );
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { bearer: 'tok', publicKey: agent.publicKey },
    });
    await client.getOwnIdentity();
    expect(requests[0].url).toBe(
      `${AVO_API}/v1/agents/identity/${agent.pubkeyBase58}`,
    );
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it('getOwnIdentity throws AGENT_NOT_CONFIGURED in bearer mode without publicKey', async () => {
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      agent: { bearer: 'tok' },
    });
    await expect(client.getOwnIdentity()).rejects.toMatchObject({
      code: 'AGENT_NOT_CONFIGURED',
    });
  });

  it('rejects ambiguous auth (bearer + secretKey)', () => {
    const agent = makeAgent();
    expect(
      () =>
        new MarketClient({
          services: { avoApi: AVO_API },
          agent: {
            publicKey: agent.publicKey,
            secretKey: agent.secretKey,
            bearer: 'tok',
          },
        }),
    ).toThrow(/AGENT_AUTH_AMBIGUOUS|EITHER signer credentials.*OR `bearer`/);
  });

  it('rejects Sig mode constructed without publicKey', () => {
    const agent = makeAgent();
    expect(
      () =>
        new MarketClient({
          services: { avoApi: AVO_API },
          agent: { secretKey: agent.secretKey } as any,
        }),
    ).toThrow(/AGENT_PUBLIC_KEY_MISSING|Sig-auth mode requires/);
  });

  it('rejects an empty agent object', () => {
    expect(
      () =>
        new MarketClient({
          services: { avoApi: AVO_API },
          agent: {},
        }),
    ).toThrow(/carries neither.*secretKey.*signer.*nor.*bearer/);
  });
});

describe('MarketClient — MPL-8004 identity attach', () => {
  it('buildAttachMessage produces the canonical bytes the API verifier expects', () => {
    const msg = buildAttachMessage('AGENT', 'CORE', 1_700_000_000_000);
    expect(new TextDecoder().decode(msg)).toBe(
      'avo-portfolio-api/8004-attach/v1\nAGENT\nCORE\n1700000000000',
    );
  });

  it('POST /v1/agents/identity/attach is unauthenticated and forwards the body', async () => {
    const { fn, requests } = captureFetch(() =>
      jsonResponse({
        agentPubkey: 'A',
        coreAssetAddress: 'C',
        agentUri: 'https://example.com/manifest.json',
        attachedAt: '2026-06-17T18:00:00.000Z',
      }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    const resp = await client.attachIdentity({
      agentPubkey: 'A',
      coreAssetAddress: 'C',
      agentUri: 'https://example.com/manifest.json',
      expiresAtMs: 1_700_000_000_000,
      signatureBase58: 'sigBase58',
    });
    expect(resp.attachedAt).toBe('2026-06-17T18:00:00.000Z');
    expect(requests[0].url).toBe(`${AVO_API}/v1/agents/identity/attach`);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].body).toMatchObject({
      agentPubkey: 'A',
      coreAssetAddress: 'C',
      expiresAtMs: 1_700_000_000_000,
    });
  });
});

describe('MarketClient — error handling', () => {
  it('parses a non-2xx envelope into AvoSdkError', async () => {
    const { fn } = captureFetch(() =>
      new Response(
        JSON.stringify({ code: 'BAD_AUTH', message: 'expired', details: { ttl: 0 } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const agent = makeAgent();
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
    await expect(client.getMarket()).rejects.toMatchObject({
      status: 401,
      code: 'BAD_AUTH',
      message: 'expired',
      details: { ttl: 0 },
    });
  });

  it('parses a wrapped { success: false, error: {...} } envelope', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'slow down' },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await expect(client.healthz()).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
    });
  });

  it('falls back to HTTP_<status> when no envelope is present', async () => {
    const { fn } = captureFetch(
      () => new Response('not json', { status: 500 }),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await expect(client.healthz()).rejects.toMatchObject({
      status: 500,
      code: 'HTTP_500',
    });
  });

  it('wraps fetch failures as AvoTransportError', async () => {
    const fn: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    await expect(client.healthz()).rejects.toBeInstanceOf(AvoTransportError);
  });

  it('AvoSdkError throws as a proper Error instance', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(
          JSON.stringify({ code: 'X', message: 'y' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn });
    try {
      await client.healthz();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AvoSdkError);
    }
  });
});

describe('MarketClient — current service compatibility', () => {
  it('rejects HTTP 200 rebalance failures after keepalive whitespace without retrying', async () => {
    const error = { status: 504, code: 'REBALANCE_TIMEOUT', message: 'Partially applied',
      details: { marketPda: 'market' } };
    const { fn, requests } = captureFetch(() => new Response(
      `  \n ${JSON.stringify({ __rebalanceError: error })}`, { status: 200 },
    ));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { bearer: 'agent-token' } });
    await expect(client.rebalance({ weights: [{ asset: 'base', weightBps: 10000 }] }))
      .rejects.toMatchObject(error);
    expect(requests).toHaveLength(1);
  });

  it('keeps successful streamed results including drift-only completion', async () => {
    const result = { prepareSignature: '', settleSignature: '', legs: [],
      totalValueBeforeBase: '100', newBaseTargetWeightBps: 10000, driftAutoSuccess: true };
    const { fn } = captureFetch(() => new Response(`  ${JSON.stringify(result)}`));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { bearer: 'agent-token' } });
    expect(await client.rebalance({ weights: [{ asset: 'base', weightBps: 10000 }] }))
      .toEqual(result);
  });

  it('separates refreshing gateway auth from agent auth and omits agent auth on public reads', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    let counter = 0;
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      gatewayAuthorization: async () => `Bearer gateway-${++counter}`,
      agent: { bearer: 'agent-token' } });
    await client.getMarket();
    await client.simulateRebalance({ weights: [{ asset: 'base', weightBps: 10000 }],
      dustThresholdBps: 0, dustThresholdBase: 0n });
    await client.listMarkets();
    expect(requests.map(r => r.headers.authorization)).toEqual([
      'Bearer gateway-1', 'Bearer gateway-2', 'Bearer gateway-3',
    ]);
    expect(requests.map(r => r.headers['x-avo-agent-authorization'])).toEqual([
      'Bearer agent-token', 'Bearer agent-token', undefined,
    ]);
    expect(requests[1].body).toMatchObject({ dustThresholdBps: 0, dustThresholdBase: '0' });
    expect(requests[1].url).toBe(`${AVO_API}/v1/rebalance/simulate`);
  });

  it('fails before any request when the gateway credential is empty', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      gatewayAuthorization: ' ', agent: { bearer: 'agent-token' } });
    await expect(client.getMarket()).rejects.toMatchObject({ code: 'GATEWAY_AUTH_EMPTY' });
    expect(requests).toHaveLength(0);
  });

  it('relays Sig2 auth through the gateway without replacing its credential', async () => {
    const agent = makeAgent();
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      gatewayAuthorization: 'Bearer gateway', agent });
    await client.getQuote({ from: 'A', to: 'B', amount: 1n, onlyDirectRoutes: false });
    expect(requests[0].headers.authorization).toBe('Bearer gateway');
    expect(requests[0].headers['x-avo-agent-authorization']).toMatch(/^Sig2 /);
    expect(new URL(requests[0].url).searchParams.get('onlyDirectRoutes')).toBe('false');
  });

  it('forwards fee, dust, routing and progress controls without changing them', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({ legs: [] }));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { bearer: 'agent-token' } });
    const body = { weights: [{ asset: 'base', weightBps: 10000 }], slippageBps: 200,
      feeSlippageBps: 200, dustThresholdBps: 0, acceptLowAumTopup: false,
      progressId: 'test', onlyDirectRoutes: false, excludeDexes: 'Scorch' };
    await client.rebalance(body);
    expect(requests[0].body).toEqual(body);
  });

  it('preserves unroutable simulation legs even on a successful HTTP response', async () => {
    const result = { legs: [{ mint: 'A', direction: 'sell', unroutable: true,
      unroutableReason: 'No route', expectedOut: '0' }] };
    const { fn } = captureFetch(() => jsonResponse(result));
    const client = new MarketClient({ services: { avoApi: AVO_API }, fetch: fn,
      agent: { bearer: 'agent-token' } });
    expect(await client.simulateRebalance({ weights: [{ asset: 'base', weightBps: 10000 }] }))
      .toEqual(result);
  });
});
