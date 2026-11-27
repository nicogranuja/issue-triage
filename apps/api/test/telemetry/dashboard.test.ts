/**
 * Keeps `deploy/grafana/issue-triage.json` in step with what the app emits. Real code paths (signed
 * webhooks, a triage that succeeds and one the model refuses, a review that is undone and
 * submitted again, and a write-back) record into the Prometheus exporter, and the scrape it would
 * serve is the reference: every metric a panel queries must be in it, and every label a panel
 * matches on or groups by must be on that metric's series. Matched values must be declared ones,
 * so a typo in `outcome="refused"` fails here rather than drawing an empty panel.
 */
import { readFileSync } from 'node:fs';

import { metrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { GitHubClient } from '../../src/github/client.js';
import { CONFIGURED, METRICS, registerQueueGauges } from '../../src/telemetry/metrics.js';
import {
  ModelRefusalError,
  type TriageInput,
  type TriageModel,
  type TriageResult,
} from '../../src/triage/model.js';
import { countQueue } from '../../src/triage/queue.js';
import { RepositoryLabelCache } from '../../src/triage/labels.js';
import { TriageWorker } from '../../src/triage/worker.js';
import { createTestApp, deliver } from '../helpers/app.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { issuesPayload } from '../helpers/fixtures.js';

const DASHBOARD_PATH = new URL('../../../../deploy/grafana/issue-triage.json', import.meta.url);

interface Target {
  expr: string;
  datasource?: { type: string; uid: string };
}
interface Panel {
  type: string;
  title: string;
  datasource?: { type: string; uid: string };
  targets?: Target[];
}
interface Dashboard {
  templating: { list: { name: string; type: string; query: string }[] };
  panels: Panel[];
}

/** Answers issue 42 after a corrective turn, through the fallback; refuses anything else. */
class ScriptedModel implements TriageModel {
  readonly provider = 'anthropic' as const;
  readonly modelId = 'claude-opus-5-5';
  readonly effort = 'medium' as const;
  readonly promptVersion = 'triage-v1';

  suggest(input: TriageInput): Promise<TriageResult> {
    if (input.issue.number !== 42) {
      return Promise.reject(new ModelRefusalError(null));
    }
    return Promise.resolve({
      suggestion: {
        summary: 'The export crashes',
        labels: { names: ['bug'], confidence: 0.9, rationale: 'A crash' },
        priority: { level: 'high', confidence: 0.7, rationale: 'Data loss' },
        duplicates: { issues: [], confidence: 0.8, rationale: 'None similar' },
      },
      model: 'claude-opus-5-5',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
      },
      fallback: true,
      modelCalls: 2,
      latencyMs: 12,
    });
  }
}

/** Series in a Prometheus text exposition: name, then the label names seen on any of them. */
function parseExposition(text: string): Map<string, Set<string>> {
  const series = new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+\S+/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const labels = series.get(match[1]) ?? new Set<string>();
    for (const label of (match[2] ?? '').matchAll(/([a-zA-Z_]\w*)="(?:[^"\\]|\\.)*"/g)) {
      labels.add(label[1] ?? '');
    }
    series.set(match[1], labels);
  }
  return series;
}

interface Matcher {
  label: string;
  op: string;
  value: string;
}
interface Query {
  /** Metric names selected, in order. */
  metrics: string[];
  /** Label matchers, by the metric they select on. */
  matchers: { metric: string; matcher: Matcher }[];
  /** Labels in `by (...)` and `without (...)` clauses. */
  grouping: string[];
  /** Dashboard variables used, other than Grafana's built-in `$__` ones. */
  variables: string[];
}

const PROMQL_KEYWORDS = new Set([
  'by',
  'without',
  'or',
  'and',
  'unless',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'offset',
]);

/**
 * Enough of PromQL for this dashboard's queries: selectors with or without matchers, functions,
 * aggregations with `by`/`without`, range selectors, numbers, and Grafana variables.
 */
function parseQuery(expr: string): Query {
  const variables = [...expr.matchAll(/\$(?!__)(\w+)/g)].map((match) => match[1] ?? '');
  let text = expr.replace(/\$__\w+/g, '5m').replace(/\$\w+/g, '1');
  const grouping: string[] = [];
  text = text.replace(/\b(?:by|without)\s*\(([^)]*)\)/g, (_, labels: string) => {
    grouping.push(
      ...labels
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
    );
    return ' ';
  });
  const names: string[] = [];
  const matchers: Query['matchers'] = [];
  text = text.replace(
    /(?<![\w.])([a-zA-Z_:][\w:]*)?\s*\{([^}]*)\}/g,
    (_, metric: string | undefined, body: string) => {
      if (!metric) {
        throw new Error(`A selector without a metric name in: ${expr}`);
      }
      names.push(metric);
      const rest = body.replace(
        /([a-zA-Z_]\w*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"\s*,?/g,
        (__, label: string, op: string, value: string) => {
          matchers.push({ metric, matcher: { label, op, value } });
          return '';
        },
      );
      if (rest.trim() !== '') {
        throw new Error(`Unparsed matchers "${rest}" in: ${expr}`);
      }
      return ' ';
    },
  );
  text = text.replace(/\[[^\]]*\]/g, ' ');
  for (const match of text.matchAll(/(?<![\w.])([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    const name = match[1] ?? '';
    if (!match[2] && !PROMQL_KEYWORDS.has(name)) {
      names.push(name);
    }
  }
  return { metrics: names, matchers, grouping, variables };
}

/** Declared metrics by their Prometheus name, with their labels in Prometheus form. */
type LabelValues = readonly string[] | typeof CONFIGURED;

function declaredByPrometheusName(): Map<
  string,
  { key: string; labels: Map<string, LabelValues> }
> {
  const declared = new Map<string, { key: string; labels: Map<string, LabelValues> }>();
  for (const [key, definition] of Object.entries(METRICS)) {
    const base = definition.name.replaceAll('.', '_');
    const entries: [string, LabelValues][] = Object.entries(
      definition.labels as Record<string, LabelValues>,
    ).map(([label, values]) => [label.replaceAll('.', '_'), values]);
    const labels = new Map(entries);
    const names =
      definition.type === 'counter'
        ? [`${base}_total`]
        : definition.type === 'histogram'
          ? [`${base}_bucket`, `${base}_sum`, `${base}_count`]
          : [base];
    for (const name of names) {
      declared.set(name, { key, labels });
    }
  }
  return declared;
}

function queries(dashboard: Dashboard): { panel: string; expr: string }[] {
  return dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ panel: panel.title, expr: target.expr })),
  );
}

describe('the Grafana dashboard', () => {
  const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8')) as Dashboard;
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ readers: [exporter] });
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let scraped: Map<string, Set<string>>;

  beforeAll(async () => {
    metrics.setGlobalMeterProvider(meterProvider);
    database = await createMigratedTestDatabase();
    registerQueueGauges(() => countQueue(database.db));
    app = await createTestApp(database, { WRITE_BACK_DELAY_MS: '0' });
    const github = new FakeGitHub({ labels: ['bug', 'P1'], issues: { 42: [], 43: [] } });
    const client = new GitHubClient({ token: 'ghp_test', fetch: github.fetch });
    const labels = new RepositoryLabelCache(database.db, client);
    const worker = new TriageWorker({
      db: database.db,
      model: new ScriptedModel(),
      labels,
      logger: pino({ level: 'silent' }),
      concurrency: 1,
      maxAttempts: 3,
      jobTimeoutMs: 5_000,
      random: () => 0,
      writeBack: { github: client, labels, mode: 'github' },
    });

    const opened = issuesPayload('issues.opened');
    const refused = issuesPayload('issues.opened');
    refused.issue.id = 2849301123;
    refused.issue.number = 43;
    expect((await deliver(app, { event: 'issues', payload: opened })).statusCode).toBe(200);
    expect((await deliver(app, { event: 'issues', payload: refused })).statusCode).toBe(200);
    await deliver(app, { event: 'issues', payload: opened, deliveryId: 'dashboard-1' });
    await deliver(app, { event: 'issues', payload: opened, deliveryId: 'dashboard-1' });
    await deliver(app, { event: 'issues', payload: opened, signature: null });
    await deliver(app, { event: 'issues', rawBody: '{', payload: null });
    await deliver(app, { event: 'star', payload: { action: 'created' } });

    // Both triage jobs: one suggestion, one refusal (a job failure that won't be retried).
    expect(await worker.runNext()).toBe(true);
    expect(await worker.runNext()).toBe(true);

    const queue = await app.inject({ method: 'GET', url: '/api/queue' });
    const [item] = queue.json<{ items: { suggestionId: number }[] }>().items;
    if (!item) {
      throw new Error('No suggestion in the review queue');
    }
    const url = `/api/suggestions/${item.suggestionId}/review`;
    const accept = { method: 'POST', url, payload: { decision: 'accept' } } as const;
    expect((await app.inject(accept)).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(204);
    expect((await app.inject(accept)).statusCode).toBe(200);
    while (await worker.runNext()) {
      // The write-back, and the undone review's cancelled one if it is still queued.
    }
    expect(github.issueLabels.get(42)).toEqual(['bug']);

    const { resourceMetrics, errors } = await exporter.collect();
    expect(errors).toEqual([]);
    scraped = parseExposition(new PrometheusSerializer().serialize(resourceMetrics));
  });

  afterAll(async () => {
    await app.close();
    await database.close();
    metrics.disable();
    await meterProvider.shutdown();
  });

  it('exercised every declared metric, failures and undone reviews included', () => {
    for (const name of declaredByPrometheusName().keys()) {
      expect(scraped.has(name), name).toBe(true);
    }
  });

  it('queries only metrics that are emitted', () => {
    const all = queries(dashboard);
    expect(all.length).toBeGreaterThan(20);
    for (const { panel, expr } of all) {
      const parsed = parseQuery(expr);
      expect(parsed.metrics.length, `${panel}: ${expr}`).toBeGreaterThan(0);
      for (const metric of parsed.metrics) {
        expect(scraped.has(metric), `${panel}: ${metric} is emitted`).toBe(true);
      }
    }
  });

  it('matches and groups only on labels the metrics carry, with declared values', () => {
    const declared = declaredByPrometheusName();
    for (const { panel, expr } of queries(dashboard)) {
      const parsed = parseQuery(expr);
      for (const label of parsed.grouping) {
        for (const metric of parsed.metrics) {
          expect(scraped.get(metric)?.has(label), `${panel}: ${metric} has ${label}`).toBe(true);
          // `le` comes from the histogram; anything else must be a declared, bounded label.
          if (label !== 'le') {
            expect(declared.get(metric)?.labels.has(label), `${panel}: ${label} declared`).toBe(
              true,
            );
          }
        }
      }
      for (const { metric, matcher } of parsed.matchers) {
        const where = `${panel}: ${metric}{${matcher.label}${matcher.op}"${matcher.value}"}`;
        expect(scraped.get(metric)?.has(matcher.label), where).toBe(true);
        const allowed = declared.get(metric)?.labels.get(matcher.label);
        expect(allowed, where).toBeDefined();
        if (allowed !== CONFIGURED && (matcher.op === '=' || matcher.op === '=~')) {
          const values = matcher.op === '=' ? [matcher.value] : matcher.value.split('|');
          for (const value of values) {
            expect(allowed, where).toContain(value);
          }
        }
      }
    }
  });

  it('puts every declared metric on a panel', () => {
    const queried = new Set(queries(dashboard).flatMap(({ expr }) => parseQuery(expr).metrics));
    const keys = new Set(
      [...declaredByPrometheusName()]
        .filter(([name]) => queried.has(name))
        .map(([, { key }]) => key),
    );
    expect([...keys].sort()).toEqual(Object.keys(METRICS).sort());
  });

  it('uses the templated Prometheus data source and only declared variables', () => {
    const variables = new Map(dashboard.templating.list.map((entry) => [entry.name, entry]));
    expect(variables.get('datasource')).toMatchObject({ type: 'datasource', query: 'prometheus' });
    for (const panel of dashboard.panels.filter((entry) => entry.type !== 'row')) {
      expect(panel.datasource, panel.title).toEqual({ type: 'prometheus', uid: '${datasource}' });
      for (const target of panel.targets ?? []) {
        expect(target.datasource, panel.title).toEqual(panel.datasource);
        for (const variable of parseQuery(target.expr).variables) {
          expect(variables.has(variable), `${panel.title}: $${variable}`).toBe(true);
        }
      }
    }
  });
});
