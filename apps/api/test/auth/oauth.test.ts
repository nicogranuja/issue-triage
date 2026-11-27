import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  codeChallenge,
  createAuthorization,
  exchangeCode,
  GITHUB_TOKEN_URL,
  OAuthError,
  stateMatches,
} from '../../src/auth/oauth.js';

const client = {
  clientId: 'Iv1.test-client-id',
  clientSecret: 'test-client-secret-not-real',
  redirectUri: 'http://127.0.0.1:3000/auth/github/callback',
};

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('createAuthorization', () => {
  it('sends state and an S256 PKCE challenge, never the verifier', () => {
    const { url, state, codeVerifier } = createAuthorization(client);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    });
    expect(url).not.toContain(codeVerifier);
    expect(url).not.toContain(client.clientSecret);
  });

  it('makes a fresh 32-byte state and verifier each time', () => {
    const first = createAuthorization(client);
    const second = createAuthorization(client);
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(Buffer.from(first.state, 'base64url')).toHaveLength(32);
    // RFC 7636: 43 to 128 characters from the unreserved set.
    expect(first.codeVerifier).toMatch(/^[\w-]{43}$/);
  });

  it('matches the RFC 7636 example challenge', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('stateMatches', () => {
  it('accepts only the exact state', () => {
    expect(stateMatches('abc123', 'abc123')).toBe(true);
    expect(stateMatches('abc123', 'abc124')).toBe(false);
    expect(stateMatches('abc123', 'abc12')).toBe(false);
    expect(stateMatches('abc123', undefined)).toBe(false);
    expect(stateMatches('abc123', ['abc123'])).toBe(false);
    expect(stateMatches('', '')).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('posts the code with the verifier and returns the token', async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      Response.json({ access_token: 'gho_test', token_type: 'bearer', scope: '' }),
    );
    await expect(
      exchangeCode(client, { code: 'code-1', codeVerifier: 'verifier-1' }, fetchImpl),
    ).resolves.toBe('gho_test');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GITHUB_TOKEN_URL);
    expect(calls[0]?.init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.init.body as string))).toEqual({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: 'code-1',
      redirect_uri: client.redirectUri,
      code_verifier: 'verifier-1',
    });
  });

  it.each([
    ['an error field', () => Response.json({ error: 'bad_verification_code' }), /bad_verification/],
    ['an odd error field', () => Response.json({ error: 'code-1 <x>' }), /: unknown$/],
    ['an HTTP error', () => new Response('nope', { status: 502 }), /HTTP 502/],
    ['no token', () => Response.json({ token_type: 'bearer' }), /no token/],
    ['a body that is not JSON', () => new Response('<html>'), /no token/],
  ])('fails on %s without quoting the code', async (_, respond, message) => {
    const { fetchImpl } = fakeFetch(respond);
    const failure = exchangeCode(client, { code: 'code-1', codeVerifier: 'v' }, fetchImpl);
    await expect(failure).rejects.toThrow(OAuthError);
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(/code-1/);
  });

  it('fails when the request does not complete', async () => {
    const fetchImpl = (() => Promise.reject(new Error('socket hang up'))) as typeof fetch;
    await expect(
      exchangeCode(client, { code: 'code-1', codeVerifier: 'v' }, fetchImpl),
    ).rejects.toThrow('did not complete');
  });
});
