/**
 * Manual spans. Auto-instrumentation needs ESM loader hooks and misses `fetch`, so the app makes
 * its own spans around the work that matters (a triage job, a write-back) with `inSpan`.
 *
 * Without a registered tracer provider these are no-ops: the OpenTelemetry API ships a no-op
 * tracer, so nothing is recorded or exported until the process sets up an SDK.
 *
 * Attributes are metadata only: ids, provider, model, prompt version, outcome. Never issue text,
 * model output, or an error message, which can contain either (a `DrizzleQueryError` carries its
 * SQL parameters). A failed span records the error's class name as `error.type` and nothing else.
 */
import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

export const TRACER_NAME = 'issue-triage';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Runs `fn` in an active span named `name`, ending it when `fn` settles. */
export function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
