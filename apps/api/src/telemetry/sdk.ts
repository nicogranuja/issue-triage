/**
 * OpenTelemetry SDK setup, once per process (the API server and `npm run worker`).
 *
 * Off unless configured: with no `OTEL_*` variables set, no provider is registered, the app's
 * spans and metrics stay the API's no-ops, and nothing is sent or served. Configuration uses the
 * standard variables:
 *
 * - `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER`: `otlp`, `none`, and for metrics also
 *   `prometheus` (comma-separated). Unset, they default to `otlp` when an OTLP endpoint is set
 *   (`OTEL_EXPORTER_OTLP_ENDPOINT`, or the signal's own `..._TRACES_ENDPOINT` /
 *   `..._METRICS_ENDPOINT`), and to `none` otherwise.
 * - The OTLP exporters (OTLP/HTTP) read their endpoint, headers, timeout, and interval
 *   (`OTEL_METRIC_EXPORT_INTERVAL`) from the environment themselves.
 * - `OTEL_EXPORTER_PROMETHEUS_HOST` / `_PORT`: where `/metrics` listens, 127.0.0.1:9464 by default.
 *   The endpoint has no authentication, so a non-loopback host logs a warning.
 * - `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`: the resource.
 * - `OTEL_SDK_DISABLED=true` turns everything off.
 */
import { randomUUID } from 'node:crypto';

import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  detectResources,
  resourceAttributesEnvDetector,
  serviceNameEnvDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { Logger } from 'pino';

import { ConfigError } from '../config.js';

export const DEFAULT_PROMETHEUS_HOST = '127.0.0.1';
export const DEFAULT_PROMETHEUS_PORT = 9464;
/** Longest wait for the last export on shutdown, so a dead collector can't hold up an exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** Attribute values are short metadata; anything longer is cut, as a backstop. */
const ATTRIBUTE_VALUE_LIMIT = 1_024;

type Env = Record<string, string | undefined>;

export interface TelemetrySettings {
  traces: 'otlp' | 'none';
  metrics: ('otlp' | 'prometheus')[];
  prometheus: { host: string; port: number };
}

const set = (value: string | undefined): value is string => (value ?? '').trim() !== '';

function exporters(
  name: string,
  value: string | undefined,
  allowed: readonly string[],
  fallback: string[],
): string[] {
  if (!set(value)) {
    return fallback;
  }
  const names = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of names) {
    if (!allowed.includes(entry)) {
      throw new ConfigError(`${name}: unsupported exporter "${entry}" (use ${allowed.join(', ')})`);
    }
  }
  return names.filter((entry) => entry !== 'none');
}

/** What the environment asks for. Exported for tests. */
export function telemetrySettings(env: Env = process.env): TelemetrySettings {
  const disabled = env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true';
  const endpoint = set(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const traces = exporters(
    'OTEL_TRACES_EXPORTER',
    env.OTEL_TRACES_EXPORTER,
    ['otlp', 'none'],
    endpoint || set(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ? ['otlp'] : [],
  );
  const metricExporters = exporters(
    'OTEL_METRICS_EXPORTER',
    env.OTEL_METRICS_EXPORTER,
    ['otlp', 'prometheus', 'none'],
    endpoint || set(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ? ['otlp'] : [],
  ) as TelemetrySettings['metrics'];
  const port = set(env.OTEL_EXPORTER_PROMETHEUS_PORT)
    ? Number(env.OTEL_EXPORTER_PROMETHEUS_PORT)
    : DEFAULT_PROMETHEUS_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError('OTEL_EXPORTER_PROMETHEUS_PORT: must be a port number');
  }
  return {
    traces: !disabled && traces.includes('otlp') ? 'otlp' : 'none',
    metrics: disabled ? [] : [...new Set(metricExporters)],
    prometheus: {
      host: set(env.OTEL_EXPORTER_PROMETHEUS_HOST)
        ? env.OTEL_EXPORTER_PROMETHEUS_HOST.trim()
        : DEFAULT_PROMETHEUS_HOST,
      port,
    },
  };
}

export interface Telemetry {
  readonly settings: TelemetrySettings;
  /** Flushes what is buffered and stops exporting. Safe to call more than once. */
  shutdown(): Promise<void>;
}

/**
 * Registers the tracer and meter providers the environment asks for. Call it first thing in a
 * process, before clients that look up a tracer are built.
 */
export function startTelemetry({
  serviceName,
  logger,
  env = process.env,
}: {
  /** Default `service.name`; `OTEL_SERVICE_NAME` overrides it. */
  serviceName: string;
  logger: Logger;
  env?: Env;
}): Telemetry {
  const settings = telemetrySettings(env);
  const stops: (() => Promise<void>)[] = [];
  if (settings.traces === 'none' && settings.metrics.length === 0) {
    return { settings, shutdown: () => Promise.resolve() };
  }

  // Detected from the environment only: no host or process detectors, which would record the
  // command line and host details nobody asked to export.
  const resource = defaultResource()
    .merge(
      resourceFromAttributes({ 'service.name': serviceName, 'service.instance.id': randomUUID() }),
    )
    .merge(detectResources({ detectors: [resourceAttributesEnvDetector, serviceNameEnvDetector] }));

  if (settings.traces === 'otlp') {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const tracerProvider = new TracerProvider({
      resource,
      spanLimits: { attributeValueLengthLimit: ATTRIBUTE_VALUE_LIMIT },
      spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    stops.push(() => tracerProvider.shutdown());
  }

  const readers: MetricReader[] = [];
  if (settings.metrics.includes('otlp')) {
    readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }));
  }
  if (settings.metrics.includes('prometheus')) {
    const { host, port } = settings.prometheus;
    readers.push(
      new PrometheusExporter({ host, port }, (error) => {
        if (error) {
          logger.error(
            { err: error, host, port },
            'could not start the Prometheus /metrics endpoint',
          );
        } else {
          logger.info({ host, port }, 'serving Prometheus metrics at /metrics');
        }
      }),
    );
    if (!isLoopback(host)) {
      logger.warn(
        { host, port },
        '/metrics has no authentication: anyone who can reach this address can read it',
      );
    }
  }
  if (readers.length > 0) {
    const meterProvider = new MeterProvider({ resource, readers });
    metrics.setGlobalMeterProvider(meterProvider);
    stops.push(() => meterProvider.shutdown());
  }
  logger.info({ traces: settings.traces, metrics: settings.metrics }, 'telemetry started');

  let stopping: Promise<void> | null = null;
  return {
    settings,
    shutdown() {
      stopping ??= withTimeout(Promise.allSettled(stops.map((stop) => stop()))).then((results) => {
        for (const result of results ?? []) {
          if (result.status === 'rejected') {
            logger.warn({ err: result.reason }, 'telemetry did not flush cleanly');
          }
        }
        if (results === null) {
          logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'telemetry flush timed out');
        }
      });
      return stopping;
    },
  };
}

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
