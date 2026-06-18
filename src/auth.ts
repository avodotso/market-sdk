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
