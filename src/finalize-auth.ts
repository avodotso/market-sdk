import bs58 from 'bs58';
import nacl from 'tweetnacl';

import type { SignerFn } from './auth';

/**
 * Creator binding for `POST /v1/markets/create/finalize`.
 *
 * Finalize hands out the market's one-time bearer, so the API requires the
 * creator wallet to sign a short-lived, single-use statement binding the
 * pending market, its agent and the funding transaction:
 *
 *   avo-portfolio-api/market-finalize/v1
 *   <creatorPubkeyB58>
 *   <pendingId>
 *   <agentPubkeyB58>
 *   <fundingSignatureB58>
 *   <expiresAtMs>
 *   <nonce>
 *
 * Literal `\n` separators, no trailing newline, ASCII. The wire value is
 * `<creatorPubkeyB58>.<expiresAtMs>.<nonce>.<signatureB58>`.
 */

export const FINALIZE_AUTH_AUDIENCE = 'avo-portfolio-api/market-finalize/v1';
export const FINALIZE_AUTH_MAX_TTL_SECS = 110;
export const FINALIZE_AUTH_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface FinalizeAuthMessageArgs {
  creator: string;
  pendingId: string;
  agentPubkey: string;
  fundingSignature: string;
  expiresAtMs: number;
  nonce: string;
}

export interface BuildCreatorAuthArgs {
  creator: string;
  pendingId: string;
  agentPubkey: string;
  fundingSignature: string;
  /** Wallet `signMessage`. Provide this or `secretKey`. */
  signMessage?: SignerFn;
  /** 64-byte Ed25519 secret key of `creator`. Provide this or `signMessage`. */
  secretKey?: Uint8Array;
  /** Integer seconds, 1..110. Default 60. */
  ttlSecs?: number;
  /** Default: 32 random hex chars. */
  nonce?: string;
  /** Clock override, for tests. Default `Date.now()`. */
  nowMs?: number;
}

export interface CreatorAuth {
  creatorAuth: string;
  expiresAtMs: number;
  nonce: string;
}

function assertPubkey(field: string, value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value);
  } catch {
    throw new Error(`${field} must be a base58 public key`);
  }
  if (bytes.length !== 32) throw new Error(`${field} must decode to 32 bytes`);
  return bytes;
}

function assertLine(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`${field} must be printable ASCII without whitespace`);
}

export function generateFinalizeNonce(): string {
  return Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function finalizeAuthMessage(args: FinalizeAuthMessageArgs): Uint8Array {
  assertPubkey('creator', args.creator);
  assertLine('pendingId', args.pendingId);
  assertPubkey('agentPubkey', args.agentPubkey);
  assertLine('fundingSignature', args.fundingSignature);
  if (!Number.isSafeInteger(args.expiresAtMs) || args.expiresAtMs <= 0) {
    throw new Error('expiresAtMs must be a positive safe integer');
  }
  if (!FINALIZE_AUTH_NONCE_RE.test(args.nonce)) {
    throw new Error('nonce must match /^[A-Za-z0-9_-]{16,64}$/');
  }
  return new TextEncoder().encode(
    [
      FINALIZE_AUTH_AUDIENCE,
      args.creator,
      args.pendingId,
      args.agentPubkey,
      args.fundingSignature,
      String(args.expiresAtMs),
      args.nonce,
    ].join('\n'),
  );
}

export async function buildCreatorAuth(args: BuildCreatorAuthArgs): Promise<CreatorAuth> {
  const creatorBytes = assertPubkey('creator', args.creator);
  const ttlSecs = args.ttlSecs ?? 60;
  if (!Number.isInteger(ttlSecs) || ttlSecs < 1 || ttlSecs > FINALIZE_AUTH_MAX_TTL_SECS) {
    throw new Error(`ttlSecs must be an integer in 1..${FINALIZE_AUTH_MAX_TTL_SECS}`);
  }
  if (args.signMessage && args.secretKey) throw new Error('Provide `signMessage` or `secretKey`, not both');
  if (!args.signMessage && !args.secretKey) throw new Error('Provide `signMessage` or `secretKey`');

  const nonce = args.nonce ?? generateFinalizeNonce();
  const expiresAtMs = (args.nowMs ?? Date.now()) + ttlSecs * 1000;
  const message = finalizeAuthMessage({
    creator: args.creator,
    pendingId: args.pendingId,
    agentPubkey: args.agentPubkey,
    fundingSignature: args.fundingSignature,
    expiresAtMs,
    nonce,
  });

  let sig: Uint8Array;
  if (args.secretKey) {
    if (args.secretKey.length !== 64) throw new Error('secretKey must be the 64-byte Ed25519 secret key');
    if (!bytesEqual(args.secretKey.subarray(32), creatorBytes)) {
      throw new Error('secretKey does not belong to creator');
    }
    sig = nacl.sign.detached(message, args.secretKey);
  } else {
    sig = await args.signMessage!(message);
  }
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new Error('signMessage must return a 64-byte Ed25519 signature');
  }
  if (!nacl.sign.detached.verify(message, sig, creatorBytes)) {
    throw new Error('signature does not verify against creator; sign with the creator wallet');
  }

  return {
    creatorAuth: `${args.creator}.${expiresAtMs}.${nonce}.${bs58.encode(sig)}`,
    expiresAtMs,
    nonce,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
