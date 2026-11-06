import type { QueueItem, Review, ReviewRequest, SuggestionDetail } from '@issue-triage/shared';

/** A queued suggestion for issue `number`, with its detail. */
export function suggestion(
  number: number,
  overrides: { title?: string; summary?: string; htmlUrl?: string; labels?: string[] } = {},
): { item: QueueItem; detail: SuggestionDetail } {
  const id = number * 10;
  const title = overrides.title ?? `Issue number ${number}`;
  const htmlUrl = overrides.htmlUrl ?? `https://github.com/lumen-labs/lumen/issues/${number}`;
  const labels = overrides.labels ?? ['bug'];
  const now = new Date().toISOString();
  return {
    item: {
      suggestionId: id,
      repository: { fullName: 'lumen-labs/lumen' },
      issue: { id: number, number, title, htmlUrl, labels: ['needs triage'], openedAt: now },
      labels,
      priority: 'high',
      confidence: 0.9,
      createdAt: now,
    },
    detail: {
      id,
      status: 'pending',
      newerSuggestionId: null,
      createdAt: now,
      model: 'fake-triage-model',
      promptVersion: 'triage-v1',
      summary: overrides.summary ?? `Summary of ${number}.`,
      labels: { names: labels, confidence: 0.9, rationale: 'Label rationale.' },
      priority: { level: 'high', confidence: 0.7, rationale: 'Priority rationale.' },
      duplicates: { issues: [], confidence: 0.4, rationale: 'Duplicate rationale.' },
      issue: {
        id: number,
        number,
        title,
        body: 'The body.',
        state: 'open',
        removed: false,
        htmlUrl,
        labels: ['needs triage'],
        authorLogin: 'octo',
        githubCreatedAt: now,
      },
      repository: {
        fullName: 'lumen-labs/lumen',
        labels: [
          { name: 'bug', description: null, color: 'd73a4a' },
          { name: 'regression', description: null, color: 'e11d21' },
          { name: 'needs triage', description: null, color: 'ededed' },
        ],
      },
      priorityLabels: {},
      review: null,
    },
  };
}

export interface ReviewCall {
  suggestionId: number;
  body: ReviewRequest;
}

interface Reply {
  status: number;
  body?: unknown;
}

/**
 * The review API, in memory, behind a fake `fetch`. Reviews succeed by default; tests can make
 * the next one wait, fail, or conflict.
 */
export class FakeApi {
  readonly items: QueueItem[];
  readonly details = new Map<number, SuggestionDetail>();
  readonly reviews: ReviewCall[] = [];
  readonly undos: number[] = [];
  #nextReply: (() => Promise<Reply>) | null = null;

  constructor(suggestions: { item: QueueItem; detail: SuggestionDetail }[]) {
    this.items = suggestions.map((entry) => entry.item);
    for (const { detail } of suggestions) {
      this.details.set(detail.id, detail);
    }
  }

  /** Answers the next review with this, once `release` resolves (default: at once). */
  replyNext(reply: Reply, release: Promise<void> = Promise.resolve()): void {
    this.#nextReply = async () => {
      await release;
      return reply;
    };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    );
    const method = init?.method ?? 'GET';
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (method === 'GET' && url.pathname === '/api/queue') {
      return json(200, { items: this.items, nextCursor: null, total: this.items.length });
    }
    if (method === 'GET' && url.pathname === '/api/repositories') {
      return json(200, {
        repositories: [{ fullName: 'lumen-labs/lumen', pending: this.items.length }],
      });
    }
    if (method === 'GET' && url.pathname === '/api/reviews') {
      return json(200, { items: [] });
    }
    const match = /^\/api\/suggestions\/(\d+)(\/review)?$/.exec(url.pathname);
    const id = Number(match?.[1]);
    if (method === 'GET' && match && !match[2]) {
      const detail = this.details.get(id);
      return detail ? json(200, detail) : json(404, { error: `No suggestion ${id}` });
    }
    if (method === 'POST' && match?.[2]) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ReviewRequest;
      this.reviews.push({ suggestionId: id, body });
      const reply = this.#nextReply;
      this.#nextReply = null;
      if (reply) {
        const { status, body: replyBody } = await reply();
        if (status >= 400) {
          return json(status, replyBody);
        }
      }
      const index = this.items.findIndex((item) => item.suggestionId === id);
      this.items.splice(index, 1);
      return json(200, { review: reviewFor(id, body) });
    }
    if (method === 'DELETE' && match?.[2]) {
      this.undos.push(id);
      return json(204);
    }
    return json(404, { error: 'Not found' });
  }) as typeof fetch;
}

function reviewFor(suggestionId: number, body: ReviewRequest): Review {
  const decision = ({ accept: 'accepted', edit: 'edited', reject: 'rejected' } as const)[
    body.decision
  ];
  return {
    id: suggestionId,
    suggestionId,
    decision,
    labels: null,
    priority: null,
    labelsAdded: [],
    labelsRemoved: [],
    note: null,
    reviewerLogin: 'local',
    createdAt: new Date().toISOString(),
    undoable: true,
    undoWindowMs: decision === 'rejected' ? null : 10_000,
    writeBack:
      decision === 'rejected'
        ? null
        : {
            jobId: 1,
            status: 'pending',
            runAfter: new Date(Date.now() + 10_000).toISOString(),
            attempts: 0,
            lastError: null,
            result: null,
            finishedAt: null,
          },
  };
}
