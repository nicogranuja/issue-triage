import { describe, expect, it } from 'vitest';

import { encodeLabelSegment, GitHubApiError, GitHubClient } from '../../src/github/client.js';

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

/** A stand-in for `fetch` that records method, URL, and JSON body. */
function fakeFetch(respond: Responder) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const request = {
      method: init?.method ?? 'GET',
      url: url.toString(),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    requests.push(request);
    return respond(request);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function rejection(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

const ISSUE_URL = 'https://api.github.com/repos/lumen-labs/lumen/issues/42';

describe('GitHubClient issue labels', () => {
  it('reads an issue and its label names', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ number: 42, state: 'open', labels: [{ name: 'bug', color: 'd73a4a' }], title: 'x' }),
    );
    const client = new GitHubClient({ token: 'ghp_test', fetch });

    expect(await client.getIssue('lumen-labs', 'lumen', 42)).toEqual({
      number: 42,
      state: 'open',
      labels: ['bug'],
    });
    expect(requests).toEqual([
      { method: 'GET', url: ISSUE_URL, body: undefined, authorization: 'Bearer ghp_test' },
    ]);
  });

  it('adds labels with one POST', async () => {
    const { fetch, requests } = fakeFetch(() => json([{ name: 'bug' }, { name: 'area: export' }]));
    const client = new GitHubClient({ token: 'ghp_test', fetch });

    await client.addLabels('lumen-labs', 'lumen', 42, ['bug', 'area: export']);

    expect(requests).toEqual([
      {
        method: 'POST',
        url: `${ISSUE_URL}/labels`,
        body: { labels: ['bug', 'area: export'] },
        authorization: 'Bearer ghp_test',
      },
    ]);
  });

  it('removes a label, and treats a label the issue no longer has as already removed', async () => {
    const { fetch, requests } = fakeFetch((request) =>
      request.url.endsWith('/needs%20triage')
        ? json([])
        : json({ message: 'Label does not exist' }, 404),
    );
    const client = new GitHubClient({ token: 'ghp_test', fetch });

    expect(await client.removeLabel('lumen-labs', 'lumen', 42, 'needs triage')).toBe(true);
    expect(await client.removeLabel('lumen-labs', 'lumen', 42, 'gone')).toBe(false);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['DELETE', `${ISSUE_URL}/labels/needs%20triage`],
      ['DELETE', `${ISSUE_URL}/labels/gone`],
    ]);
  });

  it('keeps any label name inside its own path segment', async () => {
    const { fetch, requests } = fakeFetch(() => json([]));
    const client = new GitHubClient({ fetch });

    for (const name of ['...', 'a/b', '../x', '?x=1', '#frag', 'área: ünicode', '%2e%2e']) {
      await client.removeLabel('lumen-labs', 'lumen', 42, name);
    }
    for (const request of requests) {
      const path = new URL(request.url).pathname;
      expect(path.startsWith('/repos/lumen-labs/lumen/issues/42/labels/'), path).toBe(true);
      expect(path.split('/')).toHaveLength(8);
      expect(new URL(request.url).search).toBe('');
    }
    expect(decodeURIComponent(encodeLabelSegment('área: ünicode'))).toBe('área: ünicode');

    // URL parsing would resolve these as "this" and "parent" directory, so they are refused.
    for (const name of ['.', '..']) {
      const error = await rejection(client.removeLabel('lumen-labs', 'lumen', 42, name));
      expect(error.retryable).toBe(false);
    }
    expect(requests).toHaveLength(7);
  });

  it('refuses invalid issue numbers before sending anything', async () => {
    const { fetch, requests } = fakeFetch(() => json({}));
    const client = new GitHubClient({ fetch });

    for (const number of [0, -1, 1.5, Number.NaN]) {
      expect((await rejection(client.getIssue('lumen-labs', 'lumen', number))).retryable).toBe(
        false,
      );
    }
    expect(requests).toEqual([]);
  });

  it('explains 403, 404, and 422 and does not retry them', async () => {
    const cases: [number, unknown, RegExp][] = [
      [
        403,
        { message: 'Resource not accessible by personal access token' },
        /POST .* returned 403: forbidden; GITHUB_TOKEN needs Issues write access .*Resource not accessible by personal access token/,
      ],
      [404, { message: 'Not Found' }, /returned 404: not found, or the token cannot see it/],
      [
        422,
        {
          message: 'Validation Failed',
          errors: [{ resource: 'Label', code: 'invalid', field: 'name' }],
        },
        /returned 422: GitHub rejected the change \(GitHub: Validation Failed: invalid\)/,
      ],
    ];
    for (const [status, body, message] of cases) {
      const client = new GitHubClient({ fetch: fakeFetch(() => json(body, status)).fetch });
      const error = await rejection(client.addLabels('lumen-labs', 'lumen', 42, ['bug']));
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(message);
    }
  });

  it('retries server errors, and keeps a long GitHub message to one short line', async () => {
    const message = `Server\n${'x'.repeat(500)}`;
    const client = new GitHubClient({ fetch: fakeFetch(() => json({ message }, 502)).fetch });

    const error = await rejection(client.getIssue('lumen-labs', 'lumen', 42));
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('\n');
    expect(error.message.length).toBeLessThan(300);
  });

  it('retries a secondary rate limit that comes without headers, after a minute', async () => {
    const client = new GitHubClient({
      fetch: fakeFetch(() =>
        json(
          {
            message:
              'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          },
          403,
        ),
      ).fetch,
    });
    const error = await rejection(client.addLabels('lumen-labs', 'lumen', 42, ['bug']));
    expect(error).toMatchObject({ status: 403, retryable: true, retryAfterMs: 60_000 });
    expect(error.message).toMatch(/secondary rate limit/);
  });

  it('retries a 403 that is a rate limit', async () => {
    const client = new GitHubClient({
      fetch: fakeFetch(
        () =>
          new Response('{}', {
            status: 403,
            headers: { 'retry-after': '30', 'content-type': 'application/json' },
          }),
      ).fetch,
    });
    const error = await rejection(client.addLabels('lumen-labs', 'lumen', 42, ['bug']));
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });
});
