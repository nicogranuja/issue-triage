/**
 * An in-memory stand-in for the parts of the GitHub REST API the app uses, served through a fake
 * `fetch`. It behaves like GitHub where it matters for write-back: adding a label the repository
 * doesn't have silently creates it, and removing a label the issue doesn't have answers 404.
 */

interface Failure {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeGitHubCall {
  method: string;
  path: string;
  body?: unknown;
}

export class FakeGitHub {
  /** Labels defined in the repository. */
  readonly repositoryLabels = new Set<string>();
  /** Labels on each issue, by number. */
  readonly issueLabels = new Map<number, string[]>();
  readonly calls: FakeGitHubCall[] = [];
  readonly #failures: { method: string; pattern: RegExp; failure: Failure }[] = [];
  /** Runs before each request is answered, for tests that act mid-flight. */
  beforeAnswer: ((call: FakeGitHubCall) => Promise<void> | void) | undefined;

  constructor({ labels, issues }: { labels: string[]; issues: Record<number, string[]> }) {
    for (const label of labels) {
      this.repositoryLabels.add(label);
    }
    for (const [number, issueLabels] of Object.entries(issues)) {
      this.issueLabels.set(Number(number), [...issueLabels]);
    }
  }

  /** Makes the next request with this method, whose path matches, fail. */
  failNext(method: string, pattern: RegExp, failure: Failure): void {
    this.#failures.push({ method, pattern, failure });
  }

  /** Calls that change something. */
  get writes(): FakeGitHubCall[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: FakeGitHubCall = {
      method,
      path: url.pathname,
      ...(body !== undefined && { body }),
    };
    this.calls.push(call);
    await this.beforeAnswer?.(call);

    const failureIndex = this.#failures.findIndex(
      (entry) => entry.method === method && entry.pattern.test(url.pathname),
    );
    const failure = failureIndex === -1 ? undefined : this.#failures.splice(failureIndex, 1)[0];
    if (failure) {
      return json(failure.failure.body, failure.failure.status, failure.failure.headers);
    }
    return this.#answer(method, url.pathname, body);
  }) as typeof globalThis.fetch;

  #answer(method: string, path: string, body: unknown): Response {
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
      return json(
        [...this.repositoryLabels].map((name) => ({ name, description: null, color: 'ededed' })),
      );
    }
    const issueMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/labels(?:\/(.+))?)?$/.exec(path);
    const number = Number(issueMatch?.[1]);
    const labels = this.issueLabels.get(number);
    if (!issueMatch || !labels) {
      return json({ message: 'Not Found' }, 404);
    }
    const asLabels = (names: string[]) => names.map((name) => ({ name }));

    if (method === 'GET' && !issueMatch[2]) {
      return json({ number, state: 'open', title: 'An issue', labels: asLabels(labels) });
    }
    if (method === 'POST' && issueMatch[2] && !issueMatch[3]) {
      const added = (body as { labels: string[] }).labels;
      for (const name of added) {
        const existing = [...this.repositoryLabels].find(
          (label) => label.toLowerCase() === name.toLowerCase(),
        );
        // Like GitHub: an unknown label name is created on the fly.
        if (!existing) {
          this.repositoryLabels.add(name);
        }
        const canonical = existing ?? name;
        if (!labels.some((label) => label.toLowerCase() === canonical.toLowerCase())) {
          labels.push(canonical);
        }
      }
      return json(asLabels(labels));
    }
    if (method === 'DELETE' && issueMatch[3]) {
      const name = decodeURIComponent(issueMatch[3]);
      const index = labels.findIndex((label) => label.toLowerCase() === name.toLowerCase());
      if (index === -1) {
        return json({ message: 'Label does not exist' }, 404);
      }
      labels.splice(index, 1);
      return json(asLabels(labels));
    }
    return json({ message: 'Not Found' }, 404);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
