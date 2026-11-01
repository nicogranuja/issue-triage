import { describe, expect, it } from 'vitest';

import { signPayload, verifySignature } from '../../src/webhooks/signature.js';

// Test vector from GitHub's "Validating webhook deliveries" documentation.
const DOCS_SECRET = "It's a Secret to Everybody";
const DOCS_PAYLOAD = Buffer.from('Hello, World!');
const DOCS_SIGNATURE = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe('signPayload', () => {
  it("matches GitHub's documented test vector", () => {
    expect(signPayload(DOCS_SECRET, DOCS_PAYLOAD)).toBe(DOCS_SIGNATURE);
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(DOCS_SECRET, DOCS_PAYLOAD, DOCS_SIGNATURE)).toBe(true);
  });

  it('accepts uppercase hex digits', () => {
    const upper = `sha256=${DOCS_SIGNATURE.slice('sha256='.length).toUpperCase()}`;
    expect(verifySignature(DOCS_SECRET, DOCS_PAYLOAD, upper)).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifySignature(DOCS_SECRET, DOCS_PAYLOAD, undefined)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const forged = signPayload('not-the-webhook-secret', DOCS_PAYLOAD);
    expect(verifySignature(DOCS_SECRET, DOCS_PAYLOAD, forged)).toBe(false);
  });

  it('rejects a payload modified after signing', () => {
    expect(verifySignature(DOCS_SECRET, Buffer.from('Hello, World?'), DOCS_SIGNATURE)).toBe(false);
  });

  it('rejects a payload re-serialized with different whitespace', () => {
    const raw = Buffer.from('{"action": "opened"}');
    const signature = signPayload(DOCS_SECRET, raw);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    expect(verifySignature(DOCS_SECRET, reserialized, signature)).toBe(false);
  });

  it.each([
    ['an empty header', ''],
    ['a bare digest without the algorithm prefix', DOCS_SIGNATURE.slice('sha256='.length)],
    ['a SHA-1 signature', 'sha1=0123456789abcdef0123456789abcdef01234567'],
    ['a truncated digest', DOCS_SIGNATURE.slice(0, -2)],
    ['an over-long digest', `${DOCS_SIGNATURE}00`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['surrounding whitespace', ` ${DOCS_SIGNATURE} `],
  ])('rejects %s', (_case, header) => {
    expect(verifySignature(DOCS_SECRET, DOCS_PAYLOAD, header)).toBe(false);
  });
});
