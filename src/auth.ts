/**
 * Sig-token minting for self-custodial agents.
 *
 * Every Sig-authed API call carries `Authorization: Sig <token>` where
 * the token is an Ed25519 signature over a fixed canonical message. The
 * server validates the signature against the registered agent pubkey,
 * enforces a per-token TTL, and treats the verified pubkey as the
 * authenticated identity.
 *
 * For external signers (KMS / hardware wallet / Turnkey / etc.), supply
 * a `SignerFn` instead of a raw `secretKey` — the SDK hands back the
 * canonical message bytes and you return a 64-byte Ed25519 signature.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const AUDIENCE = 'avo-portfolio-api/v1';

/** Function that signs a UTF-8 byte string with the agent's Ed25519 key
 *  and returns the raw 64-byte detached signature. Used to plug in
 *  external signers (KMS / hardware wallet / etc.). */
export type SignerFn = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface SignerInput {
  /** 32-byte Ed25519 public key. Must match a registered Agent on the API. */
  publicKey: Uint8Array;
  /** Either a 64-byte secret key (the SDK signs in-process)... */
  secretKey?: Uint8Array;
  /** ...or an external signer the SDK delegates to. */
  signer?: SignerFn;
}

/**
 * Build the canonical message the agent signs.
 *
 *   avo-portfolio-api/v1
 *   <pubkey base58>
 *   <expiresAt unix milliseconds>
 *
 * Literal newlines, no trailing newline, ASCII. Must match the API
 * verifier byte-for-byte — do not reorder or add whitespace.
 */
/**
 * @deprecated The reusable `Sig` binds no request and replays until expiry. The
 * API accepts it only on GET routes during a short compatibility window. Use
 * `mintRequestSig` (request-bound `Sig2`).
 */
export function canonicalAuthMessage(pubkeyB58: string, expiresAtMs: number): Uint8Array {
  return new TextEncoder().encode(`${AUDIENCE}\n${pubkeyB58}\n${expiresAtMs}`);
}

/**
 * Mint a fresh `<pubkey>.<expiresAtMs>.<sigBase58>` token. The client
 * stamps `Authorization: Sig <token>` on the wire.
 *
 * Either `secretKey` or `signer` must be provided; supplying both is
 * fine (signer wins).
 */
/** @deprecated See `canonicalAuthMessage`. Use `mintRequestSig`. */
export async function mintAuthToken(
  input: SignerInput,
  ttlSecs: number,
): Promise<{ token: string; expiresAtMs: number }> {
  if (input.publicKey.length !== 32) {
    throw new Error('publicKey must be 32 bytes');
  }
  if (!input.signer && !input.secretKey) {
    throw new Error('Provide either `secretKey` or `signer`');
  }

  const expiresAtMs = Date.now() + ttlSecs * 1000;
  const pubkeyB58 = bs58.encode(input.publicKey);
  const message = canonicalAuthMessage(pubkeyB58, expiresAtMs);

  let sig: Uint8Array;
  if (input.signer) {
    sig = await input.signer(message);
  } else {
    if (input.secretKey!.length !== 64) {
      throw new Error('secretKey must be the 64-byte Ed25519 secret key');
    }
    sig = nacl.sign.detached(message, input.secretKey!);
  }
  if (sig.length !== 64) {
    throw new Error(`signer returned ${sig.length} bytes; expected 64`);
  }

  const token = `${pubkeyB58}.${expiresAtMs}.${bs58.encode(sig)}`;
  return { token, expiresAtMs };
}

// ---------------------------------------------------------------------------
// Request-bound `Sig2` (avo-portfolio-api/v3)
//
// The API requires a `Sig2` on every write, on bearer rotation and on admin
// routes. It binds one request: method, path + query, the SHA-256 of the exact
// body bytes and a single-use nonce, with an expiry at most 120 s ahead. The
// reusable `Sig` above is accepted only on GET routes during a short
// compatibility window.
// ---------------------------------------------------------------------------

export const REQUEST_SIG_AUDIENCE = 'avo-portfolio-api/v3';
/** The API refuses a `Sig2` whose expiry is more than this far ahead. */
export const REQUEST_SIG_MAX_TTL_SECS = 120;
export const REQUEST_SIG_DEFAULT_TTL_SECS = 60;
const REQUEST_SIG_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The request a `Sig2` binds. */
export interface SignedRequestTarget {
  method: string;
  /** Absolute or path-relative URL exactly as sent. Only path and query are signed. */
  url: string;
  /** The exact body string or bytes sent; omit for no body. */
  body?: string | Uint8Array;
}

/**
 * Path plus query with keys sorted (WHATWG `URLSearchParams` serialization),
 * byte-identical to the API's canonical request target.
 */
export function canonicalRequestTarget(url: string): string {
  const u = new URL(url, 'http://local');
  u.searchParams.sort();
  const query = u.searchParams.toString();
  return u.pathname + (query ? `?${query}` : '');
}

async function subtleCrypto(): Promise<SubtleCrypto> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) return subtle;
  // Node 18 exposes WebCrypto only as `require('node:crypto').webcrypto`.
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle as unknown as SubtleCrypto;
}

/** Lowercase hex SHA-256 of `body` (of the empty string when absent). */
export async function bodySha256Hex(body?: string | Uint8Array): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body ?? new Uint8Array(0);
  // Copy into an ArrayBuffer-backed view: WebCrypto's BufferSource excludes SharedArrayBuffer.
  const digest = await (await subtleCrypto()).digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 hex characters from 16 random bytes. */
export function generateRequestNonce(): string {
  return Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The exact bytes a `Sig2` signs:
 *
 *   avo-portfolio-api/v3
 *   <pubkey base58>
 *   <expiresAt unix ms>
 *   <nonce>
 *   <METHOD>
 *   <path>[?<sorted query>]
 *   <sha256 hex of the body bytes>
 *
 * Literal newlines, no trailing newline.
 */
export function requestSigMessage(
  pubkeyB58: string,
  expiresAtMs: number,
  nonce: string,
  method: string,
  canonicalTarget: string,
  bodySha256: string,
): Uint8Array {
  return new TextEncoder().encode(
    `${REQUEST_SIG_AUDIENCE}\n${pubkeyB58}\n${expiresAtMs}\n${nonce}\n${method.toUpperCase()}\n${canonicalTarget}\n${bodySha256}`,
  );
}

/**
 * A complete `Authorization` value, `Sig2 <pubkey>.<expiresAtMs>.<nonce>.<bodySha256>.<sig>`,
 * for exactly this request. Mint one per request: the API accepts each nonce once.
 */
export async function mintRequestSig(
  input: SignerInput,
  target: SignedRequestTarget,
  opts: { ttlSecs?: number; nonce?: string; now?: number } = {},
): Promise<string> {
  if (input.publicKey.length !== 32) throw new Error('publicKey must be 32 bytes');
  if (!input.signer && !input.secretKey) throw new Error('Provide either `secretKey` or `signer`');
  const ttlSecs = opts.ttlSecs ?? REQUEST_SIG_DEFAULT_TTL_SECS;
  if (!(ttlSecs > 0 && ttlSecs <= REQUEST_SIG_MAX_TTL_SECS)) {
    throw new Error(`Sig2 ttlSecs must be in (0, ${REQUEST_SIG_MAX_TTL_SECS}]`);
  }
  const nonce = opts.nonce ?? generateRequestNonce();
  if (!REQUEST_SIG_NONCE_RE.test(nonce)) throw new Error('nonce must match /^[A-Za-z0-9_-]{16,64}$/');

  const expiresAtMs = (opts.now ?? Date.now()) + Math.floor(ttlSecs * 1000);
  const pubkeyB58 = bs58.encode(input.publicKey);
  const hash = await bodySha256Hex(target.body);
  const message = requestSigMessage(pubkeyB58, expiresAtMs, nonce, target.method, canonicalRequestTarget(target.url), hash);

  let sig: Uint8Array;
  if (input.signer) {
    sig = await input.signer(message);
  } else {
    if (input.secretKey!.length !== 64) throw new Error('secretKey must be the 64-byte Ed25519 secret key');
    sig = nacl.sign.detached(message, input.secretKey!);
  }
  if (sig.length !== 64) throw new Error(`signer returned ${sig.length} bytes; expected 64`);
  return `Sig2 ${pubkeyB58}.${expiresAtMs}.${nonce}.${hash}.${bs58.encode(sig)}`;
}
