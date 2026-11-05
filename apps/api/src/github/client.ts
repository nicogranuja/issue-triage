import { z } from 'zod';

/**
 * A small client for the parts of the GitHub REST API this app reads. Hand-written rather than
 * Octokit to stay small and to make the safety rules explicit:
 *
 * - The token is only ever sent to `baseUrl`'s origin: redirects are not followed, and
 *   pagination links pointing anywhere else are refused.
 * - Owner and repository names are checked before they go into a URL path, so a crafted name
 *   cannot point the request at a different endpoint.
 * - Errors say whether retrying can help, and how long GitHub asked us to wait.
 */

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

/** A label as defined in a repository. */
export interface GitHubLabel {
  name: string;
  description: string | null;
  color: string;
}

export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';
  /** HTTP status, or null when no response arrived. */
  readonly status: number | null;
  /** Whether the same request could succeed later (rate limits, outages, timeouts). */
  readonly retryable: boolean;
  /** How long GitHub asked us to wait before retrying, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number | null, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GitHubClientOptions {
  /** A token with read access to the repositories' issues. Unauthenticated when omitted. */
  token?: string | undefined;
  baseUrl?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Upper bound on pages fetched for one listing. */
  maxPages?: number;
  fetch?: typeof fetch;
  /** Clock used to turn `X-RateLimit-Reset` into a delay. */
  now?: () => number;
}

const labelsSchema = z.array(
  z.object({
    name: z.string().min(1),
    description: z
      .string()
      .nullish()
      .transform((value) => value ?? null),
    color: z.string(),
  }),
);

// Owner and repository names as GitHub allows them. `.` and `..` would be resolved as path
// segments by URL parsing, so they are rejected outright.
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function checkName(kind: string, value: string): string {
  if (!NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new GitHubApiError(`Invalid ${kind} name: ${JSON.stringify(value)}`, null, false);
  }
  return value;
}

/** Finds the `rel="next"` URL in a `Link` header. */
function nextLink(header: string | null): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match?.[2]?.split(' ').includes('next')) {
      return match[1] ?? null;
    }
  }
  return null;
}

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_GITHUB_API_URL);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxPages = options.maxPages ?? 10;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Lists every label defined in a repository, following pagination. */
  async listLabels(
    owner: string,
    repo: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubLabel[]> {
    const path = `repos/${checkName('owner', owner)}/${checkName('repository', repo)}/labels`;
    let url: URL | null = new URL(path, this.#baseUrl);
    url.searchParams.set('per_page', '100');

    const labels: GitHubLabel[] = [];
    for (let page = 1; url; page += 1) {
      if (page > this.#maxPages) {
        throw new GitHubApiError(
          `${owner}/${repo} has more than ${this.#maxPages * 100} labels`,
          null,
          false,
        );
      }
      const response = await this.#get(url, options.signal);
      const parsed = labelsSchema.safeParse(await this.#json(response, url));
      if (!parsed.success) {
        throw new GitHubApiError(
          `Unexpected response from GET ${url.pathname}: ${z.prettifyError(parsed.error)}`,
          response.status,
          false,
        );
      }
      labels.push(...parsed.data);
      url = this.#sameOrigin(nextLink(response.headers.get('link')));
    }
    return labels;
  }

  #sameOrigin(link: string | null): URL | null {
    if (link === null) {
      return null;
    }
    const url = new URL(link);
    if (url.origin !== this.#baseUrl.origin) {
      // Following it would send the token to another host.
      throw new GitHubApiError(
        `Refusing to follow a pagination link to ${url.origin}`,
        null,
        false,
      );
    }
    return url;
  }

  async #get(url: URL, signal: AbortSignal | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'issue-triage',
      'x-github-api-version': '2022-11-28',
    };
    if (this.#token) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) {
        // The caller gave up (for example, the worker is shutting down): not a GitHub problem.
        throw error;
      }
      const reason = timeout.aborted ? `timed out after ${this.#timeoutMs} ms` : String(error);
      throw new GitHubApiError(`GET ${url.pathname} failed: ${reason}`, null, true);
    }

    if (response.ok) {
      return response;
    }
    throw this.#errorFor(url, response);
  }

  async #json(response: Response, url: URL): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GitHubApiError(`GET ${url.pathname} returned invalid JSON`, response.status, true);
    }
  }

  #errorFor(url: URL, response: Response): GitHubApiError {
    const { status, headers } = response;
    const what = `GET ${url.pathname} returned ${status}`;

    // Secondary rate limits send Retry-After; primary ones exhaust X-RateLimit-Remaining.
    const retryAfter = Number(headers.get('retry-after'));
    if ((status === 403 || status === 429) && retryAfter > 0) {
      return new GitHubApiError(`${what}: rate limited`, status, true, retryAfter * 1000);
    }
    if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
      const resetSeconds = Number(headers.get('x-ratelimit-reset'));
      const waitMs = resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - this.#now()) : undefined;
      return new GitHubApiError(`${what}: rate limit exhausted`, status, true, waitMs);
    }
    if (status >= 300 && status < 400) {
      return new GitHubApiError(`${what}: redirects are not followed`, status, false);
    }
    if (status === 401) {
      return new GitHubApiError(`${what}: check GITHUB_TOKEN`, status, false);
    }
    if (status === 404) {
      return new GitHubApiError(`${what}: not found, or the token cannot see it`, status, false);
    }
    return new GitHubApiError(what, status, status === 429 || status >= 500);
  }
}
