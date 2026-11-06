import { z } from 'zod';

/**
 * A small client for the parts of the GitHub REST API this app uses: reading a repository's
 * labels, and reading and changing an issue's labels. Hand-written rather than Octokit to stay
 * small and to make the safety rules explicit:
 *
 * - The token is only ever sent to `baseUrl`'s origin: redirects are not followed, and
 *   pagination links pointing anywhere else are refused.
 * - Owner and repository names are checked before they go into a URL path, and label names are
 *   encoded as a single path segment, so a crafted name cannot point the request at a
 *   different endpoint.
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

/** The parts of an issue the write-back needs. */
export interface GitHubIssue {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
}

export interface GitHubClientOptions {
  /**
   * A token with access to the repositories' issues: read to triage, write to apply reviews.
   * Unauthenticated when omitted (reads of public repositories only).
   */
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

const issueSchema = z.object({
  number: z.number().int(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.object({ name: z.string() })),
});

/** GitHub's error body: a message, sometimes with field errors (422). */
const errorBodySchema = z.object({
  message: z.string().optional(),
  errors: z
    .array(
      z.union([
        z.object({ message: z.string().optional(), code: z.string().optional() }),
        z.string(),
      ]),
    )
    .optional(),
});

/** Longest piece of a GitHub error message kept, so errors stay one readable line. */
const MAX_GITHUB_MESSAGE = 200;

// Owner and repository names as GitHub allows them. `.` and `..` would be resolved as path
// segments by URL parsing, so they are rejected outright.
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function checkName(kind: string, value: string): string {
  if (!NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new GitHubApiError(`Invalid ${kind} name: ${JSON.stringify(value)}`, null, false);
  }
  return value;
}

/**
 * Encodes a label name as one URL path segment. URL parsing resolves `.` and `..` segments (and
 * their percent-encoded forms, `%2e`), so those two names cannot be sent in a path at all.
 */
export function encodeLabelSegment(name: string): string {
  if (name === '.' || name === '..') {
    throw new GitHubApiError(
      `Label name ${JSON.stringify(name)} cannot be used in a URL`,
      null,
      false,
    );
  }
  return encodeURIComponent(name);
}

function checkIssueNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubApiError(`Invalid issue number: ${value}`, null, false);
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
      const response = await this.#request('GET', url, options.signal);
      const parsed = labelsSchema.safeParse(await this.#json(response, 'GET', url));
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

  /** Reads an issue's state and current labels. */
  async getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubIssue> {
    const url = this.#issueUrl(owner, repo, issueNumber, '');
    const response = await this.#request('GET', url, options.signal);
    const parsed = issueSchema.safeParse(await this.#json(response, 'GET', url));
    if (!parsed.success) {
      throw new GitHubApiError(
        `Unexpected response from GET ${url.pathname}: ${z.prettifyError(parsed.error)}`,
        response.status,
        false,
      );
    }
    const { number, state, labels } = parsed.data;
    return { number, state, labels: labels.map((label) => label.name) };
  }

  /**
   * Adds labels to an issue, keeping the ones it has. Adding a label the issue already has is a
   * no-op, so this is safe to repeat. GitHub creates any label the repository doesn't have, so
   * callers must only pass labels they have just seen in the repository's label set.
   */
  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const url = this.#issueUrl(owner, repo, issueNumber, '/labels');
    await this.#request('POST', url, options.signal, { labels });
  }

  /**
   * Removes a label from an issue. Returns false when the issue didn't have it (GitHub answers
   * 404), so a repeated removal is a no-op rather than an error. Callers should check the issue
   * exists first, since a missing issue is also a 404.
   */
  async removeLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    label: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const url = this.#issueUrl(owner, repo, issueNumber, `/labels/${encodeLabelSegment(label)}`);
    try {
      await this.#request('DELETE', url, options.signal);
      return true;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  #issueUrl(owner: string, repo: string, issueNumber: number, suffix: string): URL {
    const path = `repos/${checkName('owner', owner)}/${checkName('repository', repo)}/issues/${checkIssueNumber(issueNumber)}${suffix}`;
    return new URL(path, this.#baseUrl);
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

  async #request(
    method: 'GET' | 'POST' | 'DELETE',
    url: URL,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'issue-triage',
      'x-github-api-version': '2022-11-28',
    };
    if (this.#token) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) {
        // The caller gave up (for example, the worker is shutting down): not a GitHub problem.
        throw error;
      }
      const reason = timeout.aborted ? `timed out after ${this.#timeoutMs} ms` : String(error);
      throw new GitHubApiError(`${method} ${url.pathname} failed: ${reason}`, null, true);
    }

    if (response.ok) {
      return response;
    }
    throw this.#errorFor(method, url, response, await this.#errorMessage(response));
  }

  async #json(response: Response, method: string, url: URL): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GitHubApiError(
        `${method} ${url.pathname} returned invalid JSON`,
        response.status,
        true,
      );
    }
  }

  /** GitHub's explanation of an error, from its JSON body, shortened to one line. */
  async #errorMessage(response: Response): Promise<string | null> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    const parsed = errorBodySchema.safeParse(body);
    if (!parsed.success) {
      return null;
    }
    const details = (parsed.data.errors ?? [])
      .map((error) => (typeof error === 'string' ? error : (error.message ?? error.code)))
      .filter((detail) => detail !== undefined);
    const message = [parsed.data.message, ...details].filter(Boolean).join(': ');
    const oneLine = message.replace(/\s+/g, ' ').trim();
    if (oneLine === '') {
      return null;
    }
    return oneLine.length > MAX_GITHUB_MESSAGE
      ? `${oneLine.slice(0, MAX_GITHUB_MESSAGE)}…`
      : oneLine;
  }

  #errorFor(
    method: string,
    url: URL,
    response: Response,
    githubMessage: string | null,
  ): GitHubApiError {
    const { status, headers } = response;
    const what = `${method} ${url.pathname} returned ${status}`;
    const quoted = githubMessage ? ` (GitHub: ${githubMessage})` : '';

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
    if (status === 403) {
      const need = method === 'GET' ? 'read' : 'write';
      return new GitHubApiError(
        `${what}: forbidden; GITHUB_TOKEN needs Issues ${need} access to this repository, which must not be archived${quoted}`,
        status,
        false,
      );
    }
    if (status === 404) {
      return new GitHubApiError(
        `${what}: not found, or the token cannot see it${quoted}`,
        status,
        false,
      );
    }
    if (status === 410) {
      return new GitHubApiError(`${what}: gone (issues may be disabled)${quoted}`, status, false);
    }
    if (status === 422) {
      return new GitHubApiError(`${what}: GitHub rejected the change${quoted}`, status, false);
    }
    return new GitHubApiError(`${what}${quoted}`, status, status === 429 || status >= 500);
  }
}
