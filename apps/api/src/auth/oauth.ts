/**
 * The GitHub OAuth web flow's two protocol steps, with no HTTP framework in them: building the
 * authorize URL, and exchanging the returned code for the user's token.
 *
 * Each sign-in gets a fresh `state` (checked on the way back, against cross-site request forgery
 * and login CSRF) and a PKCE code verifier, sent to GitHub only as its S256 challenge, so a code
 * intercepted on the redirect is useless without the verifier this server keeps. Both are 32
 * random bytes, base64url.
 *
 * Not wired into routes yet: the session store, cookie, and collaborator check come next.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { LOG_MESSAGE } from '../logging.js';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const EXCHANGE_TIMEOUT_MS = 10_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** The callback URL registered on the OAuth app. */
  redirectUri: string;
}

export interface Authorization {
  /** Where to send the browser. */
  url: string;
  /** Keep server side (in the pre-login session) and compare on the callback. */
  state: string;
  /** Keep server side; sent only with the code exchange. */
  codeVerifier: string;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Starts a sign-in. Asks for no scopes, so the token can do as little as possible: enough for the
 * user's profile and public repositories. Private repositories would need `repo`; that choice
 * belongs with the collaborator check, which isn't written yet.
 */
export function createAuthorization(
  client: Pick<OAuthClient, 'clientId' | 'redirectUri'>,
): Authorization {
  const state = token();
  const codeVerifier = token();
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    allow_signup: 'false',
  }).toString();
  return { url: url.toString(), state, codeVerifier };
}

/** Whether the callback's `state` is the one this sign-in started with, in constant time. */
export function stateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || expected === '') {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A failed exchange. The message names GitHub's error code only, never the code or a token. */
export class OAuthError extends Error {
  override name = 'OAuthError';
  [LOG_MESSAGE]: string;

  constructor(message: string) {
    super(message);
    this[LOG_MESSAGE] = message;
  }
}

/** Exchanges the callback's code (with the PKCE verifier) for the user's access token. */
export async function exchangeCode(
  client: OAuthClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: client.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError('The GitHub token exchange did not complete');
  }
  if (!response.ok) {
    throw new OAuthError(`The GitHub token exchange failed with HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // GitHub reports a bad or expired code with a 200 and an `error` field.
  if (typeof body?.error === 'string') {
    const known = /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'unknown';
    throw new OAuthError(`GitHub refused the token exchange: ${known}`);
  }
  if (typeof body?.access_token !== 'string' || body.access_token === '') {
    throw new OAuthError('The GitHub token exchange returned no token');
  }
  return body.access_token;
}
