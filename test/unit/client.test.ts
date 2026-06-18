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
  canonicalAuthMessage,
} from '../../src/index';

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

describe('MarketClient — Sig auth', () => {
  let agent: ReturnType<typeof makeAgent>;
  beforeEach(() => {
    agent = makeAgent();
  });

  it('produces an Authorization: Sig token with the agent pubkey on agent-op calls', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
    });
    await client.getMarket();
    const auth = requests[0].headers.authorization;
    expect(auth).toBeTypeOf('string');
    expect(auth.startsWith('Sig ')).toBe(true);
    const [pubkey, expiresAtMs, sigB58] = auth.slice(4).split('.');
    expect(pubkey).toBe(agent.pubkeyBase58);
    expect(Number(expiresAtMs)).toBeGreaterThan(Date.now());
    const msg = canonicalAuthMessage(pubkey, Number(expiresAtMs));
    const sig = bs58.decode(sigB58);
    expect(nacl.sign.detached.verify(msg, sig, agent.publicKey)).toBe(true);
  });

  it('caches the Sig token across calls until ~30s before expiry', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, secretKey: agent.secretKey },
      tokenTtlSecs: 600,
    });
    await client.getMarket();
    await client.getAssets();
    await client.getValue(50);
    const auths = requests.map((r) => r.headers.authorization);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[1]).toBe(auths[2]);
  });

  it('delegates to an external signer when provided in place of secretKey', async () => {
    const { fn, requests } = captureFetch(() => jsonResponse({}));
    const signer = vi.fn(async (msg: Uint8Array) => nacl.sign.detached(msg, agent.secretKey));
    const client = new MarketClient({
      services: { avoApi: AVO_API },
      fetch: fn,
      agent: { publicKey: agent.publicKey, signer },
    });
    await client.getMarket();
    expect(signer).toHaveBeenCalledTimes(1);
    const args = signer.mock.calls[0];
    const calledWith = args[0] as Uint8Array;
    expect(calledWith.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(calledWith).startsWith('avo-portfolio-api/v1\n')).toBe(true);
    expect(requests[0].headers.authorization).toMatch(/^Sig /);
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
