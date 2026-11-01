import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header GitHub uses to sign deliveries with HMAC SHA-256. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

function hmac(secret: string, payload: Buffer | string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

/** Signs a payload the way GitHub does: `sha256=` followed by the hex HMAC of the raw body. */
export function signPayload(secret: string, payload: Buffer | string): string {
  return `sha256=${hmac(secret, payload).toString('hex')}`;
}

/**
 * Checks an `X-Hub-Signature-256` header against the exact bytes GitHub sent. The body must be
 * the raw request body: re-serialized JSON can differ byte-for-byte and would fail the check.
 *
 * Missing or malformed headers are rejected before any comparison. The comparison itself runs
 * in constant time, so response timing reveals nothing about how much of a forged signature
 * matched.
 */
export function verifySignature(
  secret: string,
  payload: Buffer,
  header: string | undefined,
): boolean {
  const hex = header === undefined ? undefined : SIGNATURE_PATTERN.exec(header)?.[1];
  if (hex === undefined) {
    return false;
  }
  // Both sides are 32 bytes here: the pattern only admits a 64-character hex digest.
  return timingSafeEqual(hmac(secret, payload), Buffer.from(hex, 'hex'));
}
