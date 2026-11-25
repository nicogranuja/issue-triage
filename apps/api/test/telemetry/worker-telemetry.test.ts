/**
 * End to end through the real code paths, with in-memory exporters: a signed webhook queues an
 * issue, the worker triages it, a reviewer accepts, and the worker writes the labels back to a
 * fake GitHub. Checks the span tree, that no canary (issue text, model output, a token, the
 * webhook secret) reaches any span or metric, and that every metric's labels stay in their
 * declared sets.
 */
import { context, metrics, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { GitHubClient } from '../../src/github/client.js';
import { CONFIGURED, METRICS, registerQueueGauges } from '../../src/telemetry/metrics.js';
import type { TriageInput, TriageModel, TriageResult } from '../../src/triage/model.js';
import { countQueue } from '../../src/triage/queue.js';
import { RepositoryLabelCache } from '../../src/triage/labels.js';
import { TriageWorker } from '../../src/triage/worker.js';
import { createTestApp, deliver, TEST_WEBHOOK_SECRET } from '../helpers/app.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { issuesPayload } from '../helpers/fixtures.js';

const CANARY = {
  title: 'CANARY-TITLE-7f3a export crashes',
  body: 'CANARY-BODY-91c2 stack trace attached',
  summary: 'CANARY-SUMMARY-5d8e the export crashes',
  rationale: 'CANARY-RATIONALE-0b4f',
  githubToken: 'ghp_CANARYTOKEN0123456789abcdefghijklmnop',
  webhookSecret: TEST_WEBHOOK_SECRET,
};

/** A model that answers after a corrective turn, through a fallback, echoing nothing it saw. */
class CanaryModel implements TriageModel {
  readonly provider = 'anthropic' as const;
  readonly modelId = 'claude-opus-5-5';
  readonly effort = 'medium' as const;
  readonly promptVersion = 'triage-v1';
  inputs: TriageInput[] = [];

  suggest(input: TriageInput): Promise<TriageResult> {
    this.inputs.push(input);
    return Promise.resolve({
      suggestion: {
        summary: CANARY.summary,
        labels: { names: ['bug'], confidence: 0.9, rationale: CANARY.rationale },
        priority: { level: 'high', confidence: 0.7, rationale: CANARY.rationale },
        duplicates: { issues: [], confidence: 0.8, rationale: CANARY.rationale },
      },
      model: 'claude-opus-5-5',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
      },
      fallback: true,
      modelCalls: 2,
      latencyMs: 12,
    });
  }
}

const spans = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
});
const reader = new PeriodicExportingMetricReader({
  exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new MeterProvider({ readers: [reader] });
const contextManager = new AsyncLocalStorageContextManager();

async function collect(): Promise<ResourceMetrics> {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  return resourceMetrics;
}

function points(resource: ResourceMetrics): { name: string; attributes: Attributes }[] {
  return resource.scopeMetrics.flatMap((scope) =>
    scope.metrics.flatMap((metric) =>
      metric.dataPoints.map((point) => ({
        name: metric.descriptor.name,
        attributes: point.attributes,
      })),
    ),
  );
}

function spanText(finished: readonly ReadableSpan[]): string {
  return JSON.stringify(
    finished.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      links: span.links,
      status: span.status,
      resource: span.resource.attributes,
    })),
  );
}

describe('telemetry of a triage job, end to end', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let github: FakeGitHub;
  const model = new CanaryModel();
  let finished: ReadableSpan[] = [];
  let collected: ResourceMetrics;

  beforeAll(async () => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);

    database = await createMigratedTestDatabase();
    registerQueueGauges(() => countQueue(database.db));
    app = await createTestApp(database, { WRITE_BACK_DELAY_MS: '0' });
    github = new FakeGitHub({
      labels: ['bug', 'needs triage', 'P1'],
      issues: { 42: [] },
    });
    const client = new GitHubClient({ token: CANARY.githubToken, fetch: github.fetch });
    const labels = new RepositoryLabelCache(database.db, client);
    const worker = new TriageWorker({
      db: database.db,
      model,
      labels,
      logger: pino({ level: 'silent' }),
      concurrency: 1,
      maxAttempts: 3,
      jobTimeoutMs: 5_000,
      random: () => 0,
      writeBack: { github: client, labels, mode: 'github' },
    });

    const opened = issuesPayload('issues.opened');
    opened.issue.title = CANARY.title;
    opened.issue.body = CANARY.body;
    expect((await deliver(app, { event: 'issues', payload: opened })).statusCode).toBe(200);
    // A redelivery, an unsigned request, and an event this app ignores.
    const deliveryId = 'canary-delivery-1';
    await deliver(app, { event: 'issues', payload: opened, deliveryId });
    await deliver(app, { event: 'issues', payload: opened, deliveryId });
    await deliver(app, { event: 'issues', payload: opened, signature: null });
    await deliver(app, { event: 'star', payload: { action: 'created' } });

    expect(await worker.runNext()).toBe(true);
    expect(model.inputs[0]?.issue.title).toBe(CANARY.title);

    const queue = await app.inject({ method: 'GET', url: '/api/queue' });
    const [item] = queue.json<{ items: { suggestionId: number }[] }>().items;
    if (!item) {
      throw new Error('No suggestion in the review queue');
    }
    const review = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${item.suggestionId}/review`,
      payload: { decision: 'accept' },
    });
    expect(review.statusCode).toBe(200);
    expect(await worker.runNext()).toBe(true);
    expect(github.issueLabels.get(42)).toEqual(['bug']);

    finished = spans.getFinishedSpans();
    collected = await collect();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
    trace.disable();
    metrics.disable();
    context.disable();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });

  it('produces a triage.job span tree: the label lookup and the model call inside it', () => {
    const job = finished.find((span) => span.name === 'triage.job');
    expect(job?.parentSpanContext).toBeUndefined();
    expect(job?.attributes).toMatchObject({
      'triage.provider': 'anthropic',
      'triage.model': 'claude-opus-5-5',
      'triage.outcome': 'succeeded',
    });
    const children = finished.filter(
      (span) => span.parentSpanContext?.spanId === job?.spanContext().spanId,
    );
    expect(children.map((span) => span.name).sort()).toEqual([
      'GET /repos/{owner}/{repo}/labels',
      'chat claude-opus-5-5',
    ]);
    const chat = children.find((span) => span.name.startsWith('chat'));
    expect(chat?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-opus-5-5',
      'gen_ai.response.model': 'claude-opus-5-5',
      'gen_ai.usage.input_tokens': 2000,
      'gen_ai.usage.output_tokens': 300,
      'gen_ai.usage.cache_read.input_tokens': 800,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'triage.model.calls': 2,
      'triage.model.fallback': true,
    });
    const lookup = children.find((span) => span.name.startsWith('GET'));
    expect(lookup?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'server.address': 'api.github.com',
    });
  });

  it('produces a triage.write_back span with its GitHub calls inside it', () => {
    const writeBack = finished.find((span) => span.name === 'triage.write_back');
    expect(writeBack?.parentSpanContext).toBeUndefined();
    expect(writeBack?.attributes).toMatchObject({
      'triage.write_back.mode': 'github',
      'triage.outcome': 'succeeded',
      'triage.write_back.labels_added': 1,
    });
    const children = finished.filter(
      (span) => span.parentSpanContext?.spanId === writeBack?.spanContext().spanId,
    );
    expect(children.map((span) => span.name)).toEqual([
      'GET /repos/{owner}/{repo}/labels',
      'GET /repos/{owner}/{repo}/issues/{issue_number}',
      // The fake issue's updated_at is after the review's snapshot, so events are checked.
      'GET /repos/{owner}/{repo}/issues/{issue_number}/events',
      'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
    ]);
  });

  it('records no issue text, model output, token, or webhook secret in any span or metric', () => {
    const text = spanText(finished) + JSON.stringify(points(collected));
    for (const [name, canary] of Object.entries(CANARY)) {
      expect(text, name).not.toContain(canary);
    }
    // Nor the repository: it isn't secret, but it would be an unbounded label.
    expect(JSON.stringify(points(collected))).not.toContain('lumen');
  });

  it('emits the expected metrics', () => {
    const emitted = new Set(points(collected).map((point) => point.name));
    // Nothing failed and nothing was undone in this run.
    const notExercised: string[] = [METRICS.jobFailures.name, METRICS.reviewsUndone.name];
    for (const definition of Object.values(METRICS)) {
      if (notExercised.includes(definition.name)) {
        continue;
      }
      expect(emitted, definition.name).toContain(definition.name);
    }
    const deliveries = points(collected)
      .filter((point) => point.name === METRICS.webhookDeliveries.name)
      .map((point) => point.attributes);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        { event: 'issues', outcome: 'processed' },
        { event: 'issues', outcome: 'duplicate' },
        { event: 'unknown', outcome: 'bad_signature' },
        { event: 'other', outcome: 'ignored' },
      ]),
    );
  });

  it('keeps every metric label within its declared set', () => {
    const declared = new Map<string, Record<string, readonly string[] | typeof CONFIGURED>>(
      Object.values(METRICS).map((definition) => [definition.name, definition.labels]),
    );
    for (const { name, attributes } of points(collected)) {
      const labels = declared.get(name);
      expect(labels, `${name} is declared`).toBeDefined();
      expect(Object.keys(attributes).sort(), name).toEqual(Object.keys(labels ?? {}).sort());
      for (const [key, value] of Object.entries(attributes)) {
        const allowed = labels?.[key];
        if (allowed === CONFIGURED) {
          expect(value, `${name}{${key}}`).toBe(model.modelId);
        } else {
          expect(allowed, `${name}{${key}}`).toContain(value);
        }
      }
    }
  });
});
