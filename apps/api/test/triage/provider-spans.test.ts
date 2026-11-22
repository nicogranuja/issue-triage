/**
 * The Anthropic SDK emits a span per API call once a tracer provider is registered, and
 * `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content` would make those spans carry the prompt
 * (issue text) and the completion. This captures the real spans of the clients that
 * `createTriageModel` builds, with that variable set, and checks that no issue text or model
 * output is in any of them. A control client without the pinned option shows the check can fail.
 */
import Anthropic from '@anthropic-ai/sdk';
import { trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadProcessConfig } from '../../src/config.js';
import { createTriageModel } from '../../src/triage/providers.js';
import { sampleInput, sampleSuggestion } from '../helpers/triage.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

/** Answers every request with a canned reply: no request leaves the process. */
const fakeFetch = (model: string) =>
  (() =>
    Promise.resolve(
      Response.json(
        {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: JSON.stringify(sampleSuggestion) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        { headers: { 'request-id': 'req_test' } },
      ),
    )) as typeof globalThis.fetch;

/** Every attribute value of every captured span, as text. */
function spanText(): string {
  return exporter
    .getFinishedSpans()
    .flatMap((span) => [
      ...Object.values(span.attributes).map(String),
      ...span.events.flatMap((event) => Object.values(event.attributes ?? {}).map(String)),
    ])
    .join('\n');
}

const secrets = [sampleInput.issue.title, sampleSuggestion.summary];

describe('SDK spans from the triage clients', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });
  beforeEach(() => {
    exporter.reset();
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_PROFILE',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_PROFILE',
    ]) {
      vi.stubEnv(name, undefined);
    }
    // What would switch an unpinned client to recording prompts and completions.
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE', 'content');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('control: an unpinned client puts issue text in its spans under that variable', async () => {
    const client = new Anthropic({
      apiKey: 'sk-ant-test-key',
      fetch: fakeFetch('claude-opus-5-5'),
    });
    await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: sampleInput.issue.title }],
    });
    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    expect(spanText()).toContain(sampleInput.issue.title);
  });

  it('anthropic: spans are emitted, with metadata only', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    const config = loadProcessConfig({ TRIAGE_PROVIDER: 'anthropic' }).triage;
    const model = await createTriageModel(config, { fetch: fakeFetch('claude-opus-5-5') });
    await model.suggest(sampleInput, { signal: new AbortController().signal });

    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    const text = spanText();
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });

  it('bedrock: spans are emitted, with metadata only', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    const config = loadProcessConfig({
      TRIAGE_PROVIDER: 'bedrock',
      AWS_REGION: 'us-west-2',
    }).triage;
    const model = await createTriageModel(config, {
      fetch: fakeFetch('anthropic.claude-opus-5-5'),
    });
    await model.suggest(sampleInput, { signal: new AbortController().signal });

    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    const text = spanText();
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
