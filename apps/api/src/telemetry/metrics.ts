/**
 * The app's metrics, declared in one place with every label and the values it can take.
 *
 * Labels are bounded by construction: each one is either a fixed list below or `configured`, a
 * value set once by this process's configuration (the provider's model id). Nothing that grows
 * with the data is a label: no repository, issue, label name, job id, or error message. Those
 * belong in logs and traces, where one series per value doesn't cost anything.
 *
 * Instruments are created on whichever meter provider is registered when they are first used, and
 * again if it changes (tests swap it). With none registered they are the API's no-ops.
 */
import { JOB_KINDS, REVIEW_DECISIONS } from '@issue-triage/shared';
import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type MeterProvider,
  type ObservableGauge,
} from '@opentelemetry/api';

export const METER_NAME = 'issue-triage';

/** A label whose value comes from configuration, so a process emits one value for it. */
export const CONFIGURED = 'configured';

type LabelSpec = Readonly<Record<string, readonly string[] | typeof CONFIGURED>>;

interface MetricDefinition {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  unit: string;
  description: string;
  labels: LabelSpec;
  buckets?: readonly number[];
}

export const WEBHOOK_EVENTS = ['issues', 'label', 'ping', 'other', 'unknown'] as const;
export const WEBHOOK_OUTCOMES = [
  'processed',
  'ignored',
  'duplicate',
  'bad_signature',
  'bad_request',
] as const;
export const JOB_OUTCOMES = [
  'succeeded',
  'cancelled',
  'lease_lost',
  'retrying',
  'failed',
  'interrupted',
] as const;
/** Error classes that can show up as `error_type`; anything else is `other`. */
export const ERROR_TYPES = [
  'TriageModelError',
  'InvalidModelOutputError',
  'ModelRefusalError',
  'GitHubApiError',
  'DrizzleQueryError',
  'timeout',
  'attempts_exhausted',
  'other',
] as const;
export const GEN_AI_SYSTEMS = ['anthropic', 'aws.bedrock', 'fake'] as const;
export const MODEL_OUTCOMES = [
  'valid_first_try',
  'valid_after_retry',
  'invalid',
  'refused',
  'failed',
] as const;
export const TOKEN_TYPES = ['input', 'output', 'cache_read', 'cache_write'] as const;
export const WRITE_BACK_MODES = ['github', 'dry_run'] as const;
export const WRITE_BACK_OUTCOMES = ['succeeded', 'cancelled', 'lease_lost'] as const;
export const LABEL_CHANGES = ['added', 'removed', 'skipped', 'kept'] as const;
export const GITHUB_OPERATIONS = [
  'list_labels',
  'get_issue',
  'list_label_events',
  'add_labels',
  'remove_label',
] as const;
export const HTTP_METHODS = ['GET', 'POST', 'DELETE'] as const;
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'network_error', 'timeout'] as const;
export const QUEUE_STATES = ['due', 'delayed', 'running'] as const;
const BOOLEAN = ['true', 'false'] as const;

const model = {
  'gen_ai.system': GEN_AI_SYSTEMS,
  'gen_ai.request.model': CONFIGURED,
} as const;

/** Seconds, from 10 ms to about 80 s: the GenAI semantic conventions' advice for durations. */
const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

export const METRICS = {
  webhookDeliveries: {
    name: 'issue_triage.webhook.deliveries',
    type: 'counter',
    unit: '{delivery}',
    description: 'GitHub webhook deliveries, by event and outcome (duplicate: a redelivery)',
    labels: { event: WEBHOOK_EVENTS, outcome: WEBHOOK_OUTCOMES },
  },
  queueDepth: {
    name: 'issue_triage.queue.depth',
    type: 'gauge',
    unit: '{job}',
    description: 'Jobs in the queue: due now, waiting out a delay or backoff, or running',
    labels: { kind: JOB_KINDS, state: QUEUE_STATES },
  },
  queueAge: {
    name: 'issue_triage.queue.oldest_age',
    type: 'gauge',
    unit: 's',
    description: 'How long the oldest due job has been waiting to be claimed (0 when none)',
    labels: { kind: JOB_KINDS },
  },
  jobRuns: {
    name: 'issue_triage.job.runs',
    type: 'counter',
    unit: '{run}',
    description: 'Job runs (attempts), by kind and how they ended',
    labels: { kind: JOB_KINDS, outcome: JOB_OUTCOMES },
  },
  jobDuration: {
    name: 'issue_triage.job.duration',
    type: 'histogram',
    unit: 's',
    description: 'Time from claiming a job to the end of its run',
    labels: { kind: JOB_KINDS, outcome: JOB_OUTCOMES },
    buckets: DURATION_BUCKETS,
  },
  jobFailures: {
    name: 'issue_triage.job.failures',
    type: 'counter',
    unit: '{failure}',
    description: 'Failed job runs, by kind, error class, and whether they will be retried',
    labels: { kind: JOB_KINDS, error_type: ERROR_TYPES, retryable: BOOLEAN },
  },
  modelDuration: {
    name: 'gen_ai.client.operation.duration',
    type: 'histogram',
    unit: 's',
    description: 'Time to get a suggestion from the model, a corrective turn included',
    labels: { 'gen_ai.operation.name': ['chat'], ...model },
    buckets: DURATION_BUCKETS,
  },
  modelTokens: {
    name: 'issue_triage.model.tokens',
    type: 'counter',
    unit: '{token}',
    description: 'Tokens billed for suggestions, by type (cache_write: cache creation)',
    labels: { ...model, type: TOKEN_TYPES },
  },
  modelSuggestions: {
    name: 'issue_triage.model.suggestions',
    type: 'counter',
    unit: '{suggestion}',
    description: 'Requests for a suggestion, by outcome',
    labels: { ...model, outcome: MODEL_OUTCOMES },
  },
  validationRetries: {
    name: 'issue_triage.model.validation_retries',
    type: 'counter',
    unit: '{retry}',
    description: 'Corrective turns after output that failed validation',
    labels: model,
  },
  fallbacks: {
    name: 'issue_triage.model.fallbacks',
    type: 'counter',
    unit: '{suggestion}',
    description: 'Suggestions answered by the server-side refusal fallback model',
    labels: model,
  },
  reviews: {
    name: 'issue_triage.reviews',
    type: 'counter',
    unit: '{review}',
    description: 'Reviews submitted, by decision',
    labels: { decision: REVIEW_DECISIONS },
  },
  reviewsUndone: {
    name: 'issue_triage.reviews.undone',
    type: 'counter',
    unit: '{review}',
    description: 'Reviews taken back within the undo window',
    labels: {},
  },
  writeBacks: {
    name: 'issue_triage.write_back.runs',
    type: 'counter',
    unit: '{run}',
    description: 'Write-back runs that finished, by mode and outcome (failures: job failures)',
    labels: { mode: WRITE_BACK_MODES, outcome: WRITE_BACK_OUTCOMES },
  },
  writeBackLabels: {
    name: 'issue_triage.write_back.labels',
    type: 'counter',
    unit: '{label}',
    description: 'Label changes by write-back runs: added, removed, skipped (gone), kept (edited)',
    labels: { mode: WRITE_BACK_MODES, change: LABEL_CHANGES },
  },
  githubRequests: {
    name: 'issue_triage.github.requests',
    type: 'counter',
    unit: '{request}',
    description: 'GitHub REST API requests, by operation and status class',
    labels: {
      operation: GITHUB_OPERATIONS,
      'http.request.method': HTTP_METHODS,
      status_class: STATUS_CLASSES,
    },
  },
  githubDuration: {
    name: 'issue_triage.github.request.duration',
    type: 'histogram',
    unit: 's',
    description: 'GitHub REST API request time, by operation and status class',
    labels: {
      operation: GITHUB_OPERATIONS,
      'http.request.method': HTTP_METHODS,
      status_class: STATUS_CLASSES,
    },
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
} as const satisfies Record<string, MetricDefinition>;

type Metrics = typeof METRICS;
type MetricKey = keyof Metrics;
type ValueOf<S> = S extends readonly (infer V)[] ? V : string;
export type LabelsOf<K extends MetricKey> = {
  -readonly [L in keyof Metrics[K]['labels']]: ValueOf<Metrics[K]['labels'][L]>;
};
type Recorded = {
  [K in MetricKey]: Metrics[K]['type'] extends 'gauge' ? never : K;
}[MetricKey];

let cache: { provider: MeterProvider; instruments: Map<string, Counter | Histogram> } | null = null;

function meter() {
  return metrics.getMeter(METER_NAME);
}

function instrument(key: Recorded): Counter | Histogram {
  const provider = metrics.getMeterProvider();
  if (cache?.provider !== provider) {
    cache = { provider, instruments: new Map() };
  }
  let found = cache.instruments.get(key);
  if (!found) {
    const definition: MetricDefinition = METRICS[key];
    const options = { unit: definition.unit, description: definition.description };
    found =
      definition.type === 'counter'
        ? meter().createCounter(definition.name, options)
        : meter().createHistogram(definition.name, {
            ...options,
            ...(definition.buckets && {
              advice: { explicitBucketBoundaries: [...definition.buckets] },
            }),
          });
    cache.instruments.set(key, found);
  }
  return found;
}

/** Adds to a counter, or records a histogram value. */
export function record<K extends Recorded>(key: K, labels: LabelsOf<K>, value = 1): void {
  const target = instrument(key);
  if ('add' in target) {
    target.add(value, labels);
  } else {
    target.record(value, labels);
  }
}

/** The label for an error's class: one of {@link ERROR_TYPES}. */
export function errorType(error: unknown): (typeof ERROR_TYPES)[number] {
  const name = error instanceof Error ? error.name : '';
  return (ERROR_TYPES as readonly string[]).includes(name)
    ? (name as (typeof ERROR_TYPES)[number])
    : 'other';
}

/** The `gen_ai.system` value for a triage provider. */
export function genAiSystem(provider: string): (typeof GEN_AI_SYSTEMS)[number] {
  return provider === 'bedrock' ? 'aws.bedrock' : provider === 'anthropic' ? 'anthropic' : 'fake';
}

export interface QueueSnapshot {
  kind: (typeof JOB_KINDS)[number];
  state: (typeof QUEUE_STATES)[number];
  jobs: number;
  /** Seconds the oldest job has waited; only meaningful for `due`. */
  oldestAgeSeconds: number;
}

/**
 * Registers the queue gauges on the current meter provider. `read` runs once per collection (a
 * scrape or an export), never on the request path. Every kind and state is reported, at 0 when
 * empty, so a drained queue shows as 0 rather than as a gap.
 */
export function registerQueueGauges(read: () => Promise<QueueSnapshot[]>): () => void {
  const depth: ObservableGauge = meter().createObservableGauge(METRICS.queueDepth.name, {
    unit: METRICS.queueDepth.unit,
    description: METRICS.queueDepth.description,
  });
  const age: ObservableGauge = meter().createObservableGauge(METRICS.queueAge.name, {
    unit: METRICS.queueAge.unit,
    description: METRICS.queueAge.description,
  });
  const callback = async (result: {
    observe(observable: ObservableGauge, value: number, attributes: Attributes): void;
  }) => {
    const rows = await read();
    for (const kind of JOB_KINDS) {
      for (const state of QUEUE_STATES) {
        const row = rows.find((entry) => entry.kind === kind && entry.state === state);
        result.observe(depth, row?.jobs ?? 0, { kind, state });
      }
      const due = rows.find((entry) => entry.kind === kind && entry.state === 'due');
      result.observe(age, due?.oldestAgeSeconds ?? 0, { kind });
    }
  };
  meter().addBatchObservableCallback(callback, [depth, age]);
  return () => {
    meter().removeBatchObservableCallback(callback, [depth, age]);
  };
}
