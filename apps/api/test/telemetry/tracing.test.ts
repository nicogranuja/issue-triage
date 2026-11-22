import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { inSpan, TRACER_NAME } from '../../src/telemetry/tracing.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

describe('inSpan', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });
  beforeEach(() => {
    exporter.reset();
  });

  it('is a no-op without a tracer provider: the work still runs', async () => {
    trace.disable();
    try {
      expect(await inSpan('noop', {}, () => Promise.resolve(42))).toBe(42);
      expect(exporter.getFinishedSpans()).toEqual([]);
    } finally {
      trace.setGlobalTracerProvider(provider);
    }
  });

  it('records one ended span with the given attributes and those set inside', async () => {
    const result = await inSpan('triage.job', { 'triage.job.id': 7 }, (span) => {
      span.setAttribute('triage.outcome', 'succeeded');
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('triage.job');
    expect(span?.instrumentationScope.name).toBe(TRACER_NAME);
    expect(span?.attributes).toEqual({ 'triage.job.id': 7, 'triage.outcome': 'succeeded' });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('on failure, records only the error class: never its message, which can hold issue text', async () => {
    class DrizzleQueryError extends Error {
      override name = 'DrizzleQueryError';
    }
    const secret = 'Failed query: insert ... params: PDF export crashes on an empty panel';
    await expect(
      inSpan('triage.job', {}, () => Promise.reject(new DrizzleQueryError(secret))),
    ).rejects.toThrow(secret);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span?.attributes).toEqual({ 'error.type': 'DrizzleQueryError' });
    expect(span?.events).toEqual([]);
  });
});
