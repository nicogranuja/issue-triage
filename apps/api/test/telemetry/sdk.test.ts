import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/config.js';
import { startTelemetry, telemetrySettings } from '../../src/telemetry/sdk.js';

const logger = pino({ level: 'silent' });

/**
 * Whether spans started now are recorded: false for the API's no-op tracer. The probe is never
 * ended, so it is never queued for export.
 */
function recording(): boolean {
  return trace.getTracer('test').startSpan('probe').isRecording();
}

describe('telemetrySettings', () => {
  it('is off with no OTEL_* variables: nothing is exported or served', () => {
    expect(telemetrySettings({})).toEqual({
      traces: 'none',
      metrics: [],
      prometheus: { host: '127.0.0.1', port: 9464 },
    });
  });

  it('exports both signals over OTLP once an endpoint is set', () => {
    const settings = telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
    expect(settings.traces).toBe('otlp');
    expect(settings.metrics).toEqual(['otlp']);
  });

  it('honours per-signal endpoints and exporter lists', () => {
    expect(
      telemetrySettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }),
    ).toMatchObject({ traces: 'otlp', metrics: [] });
    expect(
      telemetrySettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'prometheus,otlp',
        OTEL_EXPORTER_PROMETHEUS_PORT: '9465',
      }),
    ).toEqual({
      traces: 'none',
      metrics: ['prometheus', 'otlp'],
      prometheus: { host: '127.0.0.1', port: 9465 },
    });
  });

  it('turns everything off with OTEL_SDK_DISABLED', () => {
    expect(
      telemetrySettings({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_METRICS_EXPORTER: 'prometheus',
      }),
    ).toMatchObject({ traces: 'none', metrics: [] });
  });

  it('refuses exporters it does not support, and bad ports', () => {
    expect(() => telemetrySettings({ OTEL_TRACES_EXPORTER: 'zipkin' })).toThrow(ConfigError);
    expect(() => telemetrySettings({ OTEL_EXPORTER_PROMETHEUS_PORT: 'http' })).toThrow(ConfigError);
  });
});

describe('startTelemetry', () => {
  afterEach(() => {
    trace.disable();
    metrics.disable();
  });

  it('registers no providers by default', async () => {
    const telemetry = startTelemetry({ serviceName: 'test', logger, env: {} });
    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
    expect(recording()).toBe(false);
    await telemetry.shutdown();
  });

  it('registers both providers for OTLP and shuts down cleanly with nothing to send', async () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      logger,
      // Nothing listens here, and nothing is recorded, so shutdown has nothing to send.
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' },
    });
    expect(metrics.getMeterProvider()).toBeInstanceOf(MeterProvider);
    expect(recording()).toBe(true);
    await telemetry.shutdown();
    await telemetry.shutdown();
  });
});
