import type Anthropic from '@anthropic-ai/sdk';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { issues } from '../src/db/schema.js';
import { GitHubApiError, GitHubClient } from '../src/github/client.js';
import { createLogger } from '../src/logging.js';
import { MessagesTriageModel } from '../src/triage/messages-model.js';
import { InvalidModelOutputError, TriageModelError } from '../src/triage/model.js';
import { createTriageModel } from '../src/triage/providers.js';
import { enqueueTriageJob } from '../src/triage/queue.js';
import { TriageWorker } from '../src/triage/worker.js';
import { deliver } from './helpers/app.js';
import { createMigratedTestDatabase } from './helpers/database.js';
import { issuesPayload } from './helpers/fixtures.js';
import { seedIssue, seedRepository } from './helpers/seed.js';
import { sampleInput, sampleSuggestion } from './helpers/triage.js';

// Distinctive strings that must never appear in a log line. The frame-shaped line checks that a
// multi-line message cannot smuggle text into the stack.
const ISSUE_TITLE = 'canary-issue-title-q8Zr';
const BODY_CANARY = 'canary-issue-body-Lm3x';
const ISSUE_BODY = `${BODY_CANARY}\n    at canaryFrame (${BODY_CANARY}.js:1:1)`;
const MODEL_OUTPUT = 'canary-model-output-T5vw';
const API_KEY = 'sk-ant-api03-canary-Kp2n';
const GITHUB_TOKEN = 'ghp_canaryToken9Wd4';
const WEBHOOK_SECRET = 'canary-webhook-secret-Hy6c0123456789';
const CANARIES = [ISSUE_TITLE, BODY_CANARY, MODEL_OUTPUT, API_KEY, GITHUB_TOKEN, WEBHOOK_SECRET];

/** The app's real logger configuration, writing to memory. */
function captureLogs(level = 'trace') {
  const lines: string[] = [];
  const logger = createLogger({ level }, { write: (line: string) => void lines.push(line) });
  return {
    logger,
    text: () => lines.join(''),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function expectNoCanaries(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  for (const canary of CANARIES) {
    expect(text).not.toContain(canary);
  }
  expect(text).not.toMatch(/bearer|x-api-key|authorization/i);
}

/** Returns what `promise` rejects with, after checking that it does carry the canaries. */
async function rejection(promise: Promise<unknown>, ...expected: string[]): Promise<Error> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason as Error,
  );
  const everything = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error.cause);
  for (const canary of expected) {
    expect(everything).toContain(canary);
  }
  return error;
}

/** Logs `error` every way the code base does. */
function logEveryWay(logger: Logger, error: Error): void {
  logger.error({ err: error }, 'with a message');
  logger.error({ err: error });
  logger.error(error);
  logger.child({ component: 'test' }).warn({ err: error, cause: error }, 'under another key');
  logger.info('as a format argument: %o', error);
}

const canaryReply = (labels: string[]) =>
  ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ...sampleSuggestion,
          labels: { ...sampleSuggestion.labels, names: labels },
        }),
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Beta.BetaMessage;

const invalidOutputModel = () =>
  new MessagesTriageModel({
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'medium',
    createMessage: () => Promise.resolve(canaryReply([MODEL_OUTPUT])),
  });

describe('log safety', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('drops SQL parameters and the values Postgres quotes from database errors', async () => {
    const insert = rejection(
      database.db
        .insert(issues)
        .values({
          repositoryId: 999_999,
          githubId: 1,
          number: 1,
          title: ISSUE_TITLE,
          body: ISSUE_BODY,
          state: 'open',
          htmlUrl: 'https://github.com/lumen-labs/lumen/issues/1',
          githubCreatedAt: new Date(),
          githubUpdatedAt: new Date(),
        })
        .then(),
      ISSUE_TITLE,
      BODY_CANARY,
    );
    // Postgres quotes the bad value in its own message: "invalid input syntax for type integer".
    const cast = rejection(
      database.db.execute(sql`select ${ISSUE_BODY}::integer`).then(),
      BODY_CANARY,
    );
    const errors = await Promise.all([insert, cast]);
    const logs = captureLogs();

    for (const error of errors) {
      expect(error).toBeInstanceOf(DrizzleQueryError);
      logEveryWay(logs.logger, error);
    }

    expectNoCanaries(logs.text());
    const [first] = logs.entries();
    expect(first).toMatchObject({
      msg: 'with a message',
      err: { type: 'DrizzleQueryError', cause: { code: '23503' } },
    });
    expect((first?.err as { stack?: string }).stack).toMatch(/^at /);
  });

  it('drops model output from validation errors', async () => {
    const error = await rejection(
      invalidOutputModel().suggest(sampleInput, { signal: new AbortController().signal }),
      MODEL_OUTPUT,
    );
    const logs = captureLogs();

    expect(error).toBeInstanceOf(InvalidModelOutputError);
    logEveryWay(logs.logger, error);

    expectNoCanaries(logs.text());
    expect(logs.entries()[0]).toMatchObject({
      err: {
        type: 'InvalidModelOutputError',
        message: 'Model output failed validation after a retry (1 problems)',
        retryable: false,
      },
    });
  });

  it('drops response bodies and headers from Anthropic SDK errors', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', API_KEY);
    const fetch = (() =>
      Promise.resolve(
        Response.json(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: `invalid x-api-key ${API_KEY} while triaging ${ISSUE_TITLE}`,
            },
          },
          { status: 401, headers: { 'request-id': 'req_canarytest', 'x-echo': API_KEY } },
        ),
      )) as typeof globalThis.fetch;
    const model = await createTriageModel(
      loadConfig({ TRIAGE_PROVIDER: 'anthropic', GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET }).triage,
      { fetch },
    );
    const error = await rejection(
      model.suggest(sampleInput, { signal: new AbortController().signal }),
      API_KEY,
      ISSUE_TITLE,
    );
    const logs = captureLogs();

    expect(error).toBeInstanceOf(TriageModelError);
    logEveryWay(logs.logger, error);

    expectNoCanaries(logs.text());
    expect(logs.entries()[0]).toMatchObject({
      err: {
        type: 'TriageModelError',
        message: 'Model request failed',
        retryable: false,
        cause: { type: 'AuthenticationError', status: 401, requestId: 'req_canarytest' },
      },
    });
  });

  it("drops GitHub's error text and network error text from GitHub errors", async () => {
    const rejecting = new GitHubClient({
      token: GITHUB_TOKEN,
      fetch: () =>
        Promise.resolve(
          Response.json(
            { message: `Validation Failed: ${ISSUE_TITLE}` },
            { status: 422, headers: { 'x-echo': GITHUB_TOKEN } },
          ),
        ),
    });
    const unreachable = new GitHubClient({
      token: GITHUB_TOKEN,
      fetch: () =>
        Promise.reject(new Error(`connect failed; authorization: Bearer ${GITHUB_TOKEN}`)),
    });
    const errors = await Promise.all([
      rejection(rejecting.addLabels('lumen-labs', 'lumen', 1, ['bug']), ISSUE_TITLE),
      rejection(unreachable.addLabels('lumen-labs', 'lumen', 1, ['bug']), GITHUB_TOKEN),
    ]);
    const logs = captureLogs();

    for (const error of errors) {
      expect(error).toBeInstanceOf(GitHubApiError);
      logEveryWay(logs.logger, error);
    }

    expectNoCanaries(logs.text());
    expect(logs.entries()[0]).toMatchObject({
      err: {
        type: 'GitHubApiError',
        message:
          'POST /repos/lumen-labs/lumen/issues/1/labels returned 422: GitHub rejected the change',
        status: 422,
      },
    });
  });

  it('keeps only the kind of a thrown non-error', () => {
    const logs = captureLogs();

    logs.logger.error({ err: `thrown string ${ISSUE_TITLE}` }, 'failed');
    logs.logger.error({ err: { message: ISSUE_TITLE, headers: { authorization: API_KEY } } });

    expectNoCanaries(logs.text());
    expect(logs.entries().map((entry) => entry.err)).toEqual([
      { type: 'string' },
      { type: 'object' },
    ]);
  });

  it('keeps issue text and secrets out of the worker logs of a failed job', async () => {
    const repository = await seedRepository(database.db);
    const issue = await seedIssue(database.db, repository.id, {
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
    });
    await enqueueTriageJob(database.db, issue.id);
    const logs = captureLogs();
    const worker = new TriageWorker({
      db: database.db,
      model: invalidOutputModel(),
      labels: {
        labelsFor: () => Promise.resolve([{ name: 'bug', description: null, color: 'd73a4a' }]),
      },
      logger: logs.logger,
      concurrency: 1,
      maxAttempts: 1,
      jobTimeoutMs: 5_000,
      workerId: 'test-worker',
    });

    expect(await worker.runNext()).toBe(true);

    expectNoCanaries(logs.text());
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({
        msg: 'triage job failed',
        err: expect.objectContaining({ type: 'InvalidModelOutputError' }) as unknown,
      }),
    );
  });

  it('keeps issue text, credentials, and the webhook secret out of the API logs', async () => {
    // A database where storing an issue fails, so the delivery's issue text ends up in the
    // parameters of the failed query.
    const broken = await createMigratedTestDatabase();
    try {
      await broken.db.execute(sql`alter table issues add constraint no_canaries check (false)`);
      const logs = captureLogs();
      const config = loadConfig({
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        TRIAGE_PROVIDER: 'fake',
      });
      const app = await buildApp({ config, db: broken.db, logger: logs.logger });
      const delivery = issuesPayload('issues.opened');
      delivery.issue.title = ISSUE_TITLE;
      delivery.issue.body = ISSUE_BODY;
      const headers = { authorization: `Bearer ${GITHUB_TOKEN}`, 'x-api-key': API_KEY };

      const failed = await deliver(app, {
        event: 'issues',
        payload: delivery,
        secret: WEBHOOK_SECRET,
        headers,
      });
      const unsigned = await deliver(app, {
        event: 'issues',
        payload: delivery,
        secret: 'wrong-secret',
        headers,
      });
      await app.close();

      expect([failed.statusCode, unsigned.statusCode]).toEqual([500, 401]);
      expectNoCanaries(logs.text());
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          msg: 'request failed',
          err: expect.objectContaining({ type: 'DrizzleQueryError' }) as unknown,
        }),
      );
    } finally {
      await broken.close();
    }
  });
});
