import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  MarketClient,
  FINALIZE_AUTH_AUDIENCE,
  buildCreatorAuth,
  finalizeAuthMessage,
  generateFinalizeNonce,
} from '../../src/index';

const creatorKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const agentKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
const CREATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const AGENT = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
const PENDING_ID = 'pending_test_1';
const FUNDING_SIG = '5'.repeat(88);
const EXPIRES_AT_MS = 1900000000000;
const NONCE = 'nonce_test_0123456789';

const GOLDEN_MESSAGE_HEX =
  '61766f2d706f7274666f6c696f2d6170692f6d61726b65742d66696e616c697a652f76310a414b6e4c344e4e66334447575a4a533663506b6e427545476e5673563441346d35746765624c486152535a390a70656e64696e675f746573745f310a39685352365337575074786d546f6a676f364747336b347944506563674a593239326a3778727355475742750a353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535350a313930303030303030303030300a6e6f6e63655f746573745f30313233343536373839';
const GOLDEN_SIG = '392zHPcFzVwUX4vbMr6Yu2zhGQdydu3uUm5pbDFmKuTCdcHp88eBqD2wF6yEnrr341r4nn68vFKZ3n2iwX29p7Yn';
const GOLDEN_CREATOR_AUTH = `${CREATOR}.${EXPIRES_AT_MS}.${NONCE}.${GOLDEN_SIG}`;

const msgArgs = {
  creator: CREATOR,
  pendingId: PENDING_ID,
  agentPubkey: AGENT,
  fundingSignature: FUNDING_SIG,
  expiresAtMs: EXPIRES_AT_MS,
  nonce: NONCE,
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('finalize creator auth — golden vector', () => {
  it('derives the spec keys', () => {
    expect(bs58.encode(creatorKp.publicKey)).toBe(CREATOR);
    expect(bs58.encode(agentKp.publicKey)).toBe(AGENT);
  });

  it('builds the exact message bytes', () => {
    const msg = finalizeAuthMessage(msgArgs);
    expect(hex(msg)).toBe(GOLDEN_MESSAGE_HEX);
    expect(new TextDecoder().decode(msg)).toBe(
      `${FINALIZE_AUTH_AUDIENCE}\n${CREATOR}\n${PENDING_ID}\n${AGENT}\n${FUNDING_SIG}\n${EXPIRES_AT_MS}\n${NONCE}`,
    );
  });

  it('produces the exact creatorAuth with secretKey', async () => {
    const out = await buildCreatorAuth({
      creator: CREATOR,
      pendingId: PENDING_ID,
      agentPubkey: AGENT,
      fundingSignature: FUNDING_SIG,
      secretKey: creatorKp.secretKey,
      ttlSecs: 110,
      nonce: NONCE,
      nowMs: EXPIRES_AT_MS - 110_000,
    });
    expect(out).toEqual({ creatorAuth: GOLDEN_CREATOR_AUTH, expiresAtMs: EXPIRES_AT_MS, nonce: NONCE });
  });

  it('produces the exact creatorAuth with signMessage, signing the exact bytes', async () => {
    const seen: Uint8Array[] = [];
    const out = await buildCreatorAuth({
      creator: CREATOR,
      pendingId: PENDING_ID,
      agentPubkey: AGENT,
      fundingSignature: FUNDING_SIG,
      signMessage: async (m) => {
        seen.push(m);
        return nacl.sign.detached(m, creatorKp.secretKey);
      },
      ttlSecs: 110,
      nonce: NONCE,
      nowMs: EXPIRES_AT_MS - 110_000,
    });
    expect(out.creatorAuth).toBe(GOLDEN_CREATOR_AUTH);
    expect(seen).toHaveLength(1);
    expect(hex(seen[0])).toBe(GOLDEN_MESSAGE_HEX);
  });
});

describe('buildCreatorAuth', () => {
  const base = {
    creator: CREATOR,
    pendingId: PENDING_ID,
    agentPubkey: AGENT,
    fundingSignature: FUNDING_SIG,
  };

  it('defaults to a fresh 32-hex nonce and a 60s TTL', async () => {
    const before = Date.now();
    const a = await buildCreatorAuth({ ...base, secretKey: creatorKp.secretKey });
    const b = await buildCreatorAuth({ ...base, secretKey: creatorKp.secretKey });
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAtMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(a.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
    const [pk, exp, nonce, sig] = a.creatorAuth.split('.');
    expect(pk).toBe(CREATOR);
    expect(Number(exp)).toBe(a.expiresAtMs);
    expect(nonce).toBe(a.nonce);
    const msg = finalizeAuthMessage({ ...base, expiresAtMs: a.expiresAtMs, nonce: a.nonce });
    expect(nacl.sign.detached.verify(msg, bs58.decode(sig), creatorKp.publicKey)).toBe(true);
  });

  it('generateFinalizeNonce matches the server nonce pattern', () => {
    for (let i = 0; i < 50; i++) expect(generateFinalizeNonce()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it.each([0, 111, 1.5, -1, Number.NaN])('rejects ttlSecs=%s', async (ttlSecs) => {
    await expect(buildCreatorAuth({ ...base, secretKey: creatorKp.secretKey, ttlSecs })).rejects.toThrow(/ttlSecs/);
  });

  it('rejects a missing or doubled signer', async () => {
    await expect(buildCreatorAuth({ ...base })).rejects.toThrow(/signMessage/);
    await expect(
      buildCreatorAuth({ ...base, secretKey: creatorKp.secretKey, signMessage: async () => new Uint8Array(64) }),
    ).rejects.toThrow(/not both/);
  });

  it('rejects a secretKey that is not the creator', async () => {
    await expect(buildCreatorAuth({ ...base, secretKey: agentKp.secretKey })).rejects.toThrow(/does not belong/);
  });

  it('rejects a signMessage from the wrong wallet', async () => {
    await expect(
      buildCreatorAuth({ ...base, signMessage: (m) => nacl.sign.detached(m, agentKp.secretKey) }),
    ).rejects.toThrow(/does not verify/);
  });

  it('rejects a malformed signature length', async () => {
    await expect(buildCreatorAuth({ ...base, signMessage: () => new Uint8Array(63) })).rejects.toThrow(/64-byte/);
  });

  it.each(['short', 'has.dot.ok_but_dots_are_not_allowed', 'x'.repeat(65), 'spaces in nonce 1234'])(
    'rejects nonce %s',
    async (nonce) => {
      await expect(buildCreatorAuth({ ...base, secretKey: creatorKp.secretKey, nonce })).rejects.toThrow(/nonce/);
    },
  );

  it('rejects fields that would break the line format', async () => {
    await expect(
      buildCreatorAuth({ ...base, pendingId: 'a\nb', secretKey: creatorKp.secretKey }),
    ).rejects.toThrow(/pendingId/);
    await expect(
      buildCreatorAuth({ ...base, fundingSignature: '', secretKey: creatorKp.secretKey }),
    ).rejects.toThrow(/fundingSignature/);
    await expect(buildCreatorAuth({ ...base, creator: 'nope', secretKey: creatorKp.secretKey })).rejects.toThrow(
      /creator/,
    );
    await expect(
      buildCreatorAuth({ ...base, agentPubkey: '0OIl', secretKey: creatorKp.secretKey }),
    ).rejects.toThrow(/agentPubkey/);
  });
});

describe('AvoClient.finalizeCreateMarket', () => {
  it('sends creatorAuth in the JSON body without auth headers', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fn: typeof fetch = async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ marketPda: 'M', bearer: 'mb_x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new MarketClient({ services: { avoApi: 'https://avo-api.test' }, fetch: fn });
    await client.finalizeCreateMarket({
      agentPubkey: AGENT,
      fundingSignature: FUNDING_SIG,
      creatorAuth: GOLDEN_CREATOR_AUTH,
    });
    expect(captured!.url).toBe('https://avo-api.test/v1/markets/create/finalize');
    expect(JSON.parse(captured!.init!.body as string)).toEqual({
      agentPubkey: AGENT,
      fundingSignature: FUNDING_SIG,
      creatorAuth: GOLDEN_CREATOR_AUTH,
    });
    const headers = Object.fromEntries(
      Object.entries((captured!.init!.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers.authorization).toBeUndefined();
  });
});

describe('MarketClient.createMarketWithShadowPortfolio', () => {
  const prepBody = {
    creator: CREATOR,
    baseAssetMint: 'BaseMint',
    feeAssetMint: 'BaseMint',
    marketFeeBps: 30,
  };

  function fakeApi(prepResp: Record<string, unknown>) {
    const calls: { url: string; body: any }[] = [];
    const fn: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const body = url.endsWith('/prepare') ? prepResp : { marketPda: 'M', bearer: 'mb_x' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fn, calls };
  }

  it('signs creatorAuth over pendingId, agent and funding sig, then finalizes', async () => {
    const { fn, calls } = fakeApi({ pendingId: PENDING_ID, agentPubkey: AGENT, fundingTx: 'tx64', fundingLamports: 1, nextStep: '' });
    const client = new MarketClient({ services: { avoApi: 'https://avo-api.test' }, fetch: fn });
    const signed: Uint8Array[] = [];
    const out = await client.createMarketWithShadowPortfolio(
      prepBody,
      async (tx) => {
        expect(tx).toBe('tx64');
        return FUNDING_SIG;
      },
      async (m) => {
        signed.push(m);
        return nacl.sign.detached(m, creatorKp.secretKey);
      },
    );
    expect(out.bearer).toBe('mb_x');
    expect(calls.map((c) => c.url)).toEqual([
      'https://avo-api.test/v1/markets/create/prepare',
      'https://avo-api.test/v1/markets/create/finalize',
    ]);
    const fin = calls[1].body;
    expect(fin.agentPubkey).toBe(AGENT);
    expect(fin.fundingSignature).toBe(FUNDING_SIG);
    const [pk, exp, nonce, sig] = fin.creatorAuth.split('.');
    expect(pk).toBe(CREATOR);
    const msg = finalizeAuthMessage({
      creator: CREATOR,
      pendingId: PENDING_ID,
      agentPubkey: AGENT,
      fundingSignature: FUNDING_SIG,
      expiresAtMs: Number(exp),
      nonce,
    });
    expect(signed).toHaveLength(1);
    expect(hex(signed[0])).toBe(hex(msg));
    expect(nacl.sign.detached.verify(msg, bs58.decode(sig), creatorKp.publicKey)).toBe(true);
  });

  it('refuses before prepare when signMessage is missing', async () => {
    const { fn, calls } = fakeApi({ pendingId: PENDING_ID, agentPubkey: AGENT, fundingTx: 'tx64' });
    const client = new MarketClient({ services: { avoApi: 'https://avo-api.test' }, fetch: fn });
    await expect(
      (client.createMarketWithShadowPortfolio as any)(prepBody, async () => FUNDING_SIG),
    ).rejects.toMatchObject({ code: 'SIGN_MESSAGE_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses before funding when the API returns no pendingId', async () => {
    const { fn, calls } = fakeApi({ agentPubkey: AGENT, fundingTx: 'tx64' });
    const client = new MarketClient({ services: { avoApi: 'https://avo-api.test' }, fetch: fn });
    let funded = false;
    await expect(
      client.createMarketWithShadowPortfolio(
        prepBody,
        async () => {
          funded = true;
          return FUNDING_SIG;
        },
        async (m) => nacl.sign.detached(m, creatorKp.secretKey),
      ),
    ).rejects.toMatchObject({ code: 'PENDING_ID_MISSING' });
    expect(funded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does not finalize when signMessage uses the wrong wallet', async () => {
    const { fn, calls } = fakeApi({ pendingId: PENDING_ID, agentPubkey: AGENT, fundingTx: 'tx64' });
    const client = new MarketClient({ services: { avoApi: 'https://avo-api.test' }, fetch: fn });
    await expect(
      client.createMarketWithShadowPortfolio(
        prepBody,
        async () => FUNDING_SIG,
        async (m) => nacl.sign.detached(m, agentKp.secretKey),
      ),
    ).rejects.toThrow(/does not verify/);
    expect(calls).toHaveLength(1);
  });
});
