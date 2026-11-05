import { describe, expect, it } from 'vitest';

import { GitHubApiError, GitHubClient } from '../../src/github/client.js';

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
}

type Responder = (url: URL) => Response | Promise<Response>;

/** A stand-in for `fetch` that records requests and answers from a function. */
function fakeFetch(respond: Responder) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
    });
    return respond(url);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const bug = { name: 'bug', description: "Something isn't working", color: 'd73a4a' };
const docs = { name: 'documentation', description: null, color: '0075ca' };

async function expectGitHubError(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

describe('GitHubClient.listLabels', () => {
  it('requests the labels with the token and API version, and returns them', async () => {
    const { fetch, requests } = fakeFetch(() => json([bug, docs]));
    const client = new GitHubClient({ token: 'ghp_test_token', fetch });

    expect(await client.listLabels('lumen-labs', 'lumen')).toEqual([bug, docs]);

    expect(requests).toEqual([
      {
        url: 'https://api.github.com/repos/lumen-labs/lumen/labels?per_page=100',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ghp_test_token',
          'user-agent': 'issue-triage',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'manual',
      },
    ]);
  });

  it('sends no Authorization header without a token', async () => {
    const { fetch, requests } = fakeFetch(() => json([]));

    await new GitHubClient({ fetch }).listLabels('lumen-labs', 'lumen');

    expect(requests[0]?.headers).not.toHaveProperty('authorization');
  });

  it('follows pagination links', async () => {
    const page2 = 'https://api.github.com/repositories/708812345/labels?per_page=100&page=2';
    const { fetch, requests } = fakeFetch((url) =>
      url.searchParams.get('page') === '2'
        ? json([docs], { headers: { link: `<${page2}>; rel="prev"` } })
        : json([bug], { headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` } }),
    );

    const labels = await new GitHubClient({ fetch }).listLabels('lumen-labs', 'lumen');

    expect(labels.map((label) => label.name)).toEqual(['bug', 'documentation']);
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/lumen-labs/lumen/labels?per_page=100',
      page2,
    ]);
  });

  it('refuses a pagination link to another host, so the token is never sent there', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json([bug], { headers: { link: '<https://evil.example/labels?page=2>; rel="next"' } }),
    );

    const error = await expectGitHubError(
      new GitHubClient({ token: 'ghp_test_token', fetch }).listLabels('lumen-labs', 'lumen'),
    );

    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('stops after the page limit', async () => {
    const { fetch } = fakeFetch((url) =>
      json([bug], { headers: { link: `<${url.origin}${url.pathname}?page=2>; rel="next"` } }),
    );

    const error = await expectGitHubError(
      new GitHubClient({ fetch, maxPages: 3 }).listLabels('lumen-labs', 'lumen'),
    );
    expect(error.message).toMatch(/more than 300 labels/);
  });

  it.each(['..', '.', 'lumen/../../user', 'lumen%2F..', ''])(
    'rejects the repository name %j before sending anything',
    async (name) => {
      const { fetch, requests } = fakeFetch(() => json([]));

      await expectGitHubError(new GitHubClient({ fetch }).listLabels('lumen-labs', name));

      expect(requests).toEqual([]);
    },
  );

  describe('errors', () => {
    const listWith = (respond: Responder, options = {}) =>
      new GitHubClient({ fetch: fakeFetch(respond).fetch, ...options }).listLabels(
        'lumen-labs',
        'lumen',
      );

    it.each([
      [401, false],
      [403, false],
      [404, false],
      [422, false],
      [429, true],
      [500, true],
      [503, true],
    ])('treats a %i response as retryable: %s', async (status, retryable) => {
      const error = await expectGitHubError(listWith(() => json({ message: 'nope' }, { status })));
      expect(error).toMatchObject({ status, retryable });
    });

    it('reports when an exhausted primary rate limit resets', async () => {
      const now = Date.parse('2026-11-04T12:00:00Z');
      const reset = String(now / 1000 + 90);

      const error = await expectGitHubError(
        listWith(
          () =>
            json(
              { message: 'API rate limit exceeded' },
              {
                status: 403,
                headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
              },
            ),
          { now: () => now },
        ),
      );

      expect(error).toMatchObject({ status: 403, retryable: true, retryAfterMs: 90_000 });
    });

    it('honours Retry-After on a secondary rate limit', async () => {
      const error = await expectGitHubError(
        listWith(() =>
          json(
            { message: 'You have exceeded a secondary rate limit' },
            { status: 403, headers: { 'retry-after': '60' } },
          ),
        ),
      );

      expect(error).toMatchObject({ retryable: true, retryAfterMs: 60_000 });
    });

    it('does not follow redirects', async () => {
      const error = await expectGitHubError(
        listWith(
          () =>
            new Response(null, {
              status: 301,
              headers: { location: 'https://api.github.com/repositories/1/labels' },
            }),
        ),
      );
      expect(error).toMatchObject({ status: 301, retryable: false });
    });

    it('treats a network failure as retryable', async () => {
      const error = await expectGitHubError(
        listWith(() => Promise.reject(new TypeError('fetch failed'))),
      );
      expect(error).toMatchObject({ status: null, retryable: true });
    });

    it('times out a request that takes too long', async () => {
      const hang: Responder = () => new Promise<Response>(() => undefined);
      const { fetch } = fakeFetch(hang);
      // The fake ignores the signal, so race it the way a real fetch would abort.
      const abortable = (async (input: string | URL | Request, init?: RequestInit) =>
        Promise.race([
          fetch(input, init),
          new Promise<never>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          }),
        ])) as typeof globalThis.fetch;

      const error = await expectGitHubError(
        new GitHubClient({ fetch: abortable, timeoutMs: 20 }).listLabels('lumen-labs', 'lumen'),
      );
      expect(error).toMatchObject({ retryable: true });
      expect(error.message).toMatch(/timed out after 20 ms/);
    });

    it('passes a caller abort through instead of reporting a GitHub failure', async () => {
      const controller = new AbortController();
      controller.abort(new Error('shutting down'));

      const failure: unknown = await new GitHubClient({
        fetch: (_input: string | URL | Request, init?: RequestInit) =>
          Promise.reject(init?.signal?.reason as Error),
      })
        .listLabels('lumen-labs', 'lumen', { signal: controller.signal })
        .catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(GitHubApiError);
      expect(failure).toMatchObject({ message: 'shutting down' });
    });

    it('rejects a response that is not a list of labels', async () => {
      const error = await expectGitHubError(listWith(() => json({ labels: [] })));
      expect(error.retryable).toBe(false);
    });
  });
});
