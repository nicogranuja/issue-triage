import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadProcessConfig } from '../../src/config.js';
import { FakeTriageModel } from '../../src/triage/fake-model.js';
import { MessagesTriageModel } from '../../src/triage/messages-model.js';
import { createTriageModel } from '../../src/triage/providers.js';
import { sampleInput, sampleSuggestion } from '../helpers/triage.js';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * Answers every SDK request with a canned Messages API reply, so the real Anthropic and Bedrock
 * clients run end to end (request building, auth headers, response parsing) without a network.
 */
function messagesApi(model: string) {
  const requests: Captured[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: (await request.json()) as Record<string, unknown>,
    });
    return Response.json(
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
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const signal = () => new AbortController().signal;

describe('createTriageModel', () => {
  beforeEach(() => {
    // Only the credentials a test sets explicitly may be used.
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects the fake model', async () => {
    const model = await createTriageModel(loadProcessConfig({ TRIAGE_PROVIDER: 'fake' }).triage);

    expect(model).toBeInstanceOf(FakeTriageModel);
    expect(model.provider).toBe('fake');
  });

  it('calls the Anthropic API with the default model and server-side fallbacks', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    const api = messagesApi('claude-opus-5-5');
    const config = loadProcessConfig({ TRIAGE_PROVIDER: 'anthropic' }).triage;

    const model = await createTriageModel(config, { fetch: api.fetch });
    const result = await model.suggest(sampleInput, { signal: signal() });

    expect(model).toBeInstanceOf(MessagesTriageModel);
    expect(model).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
    expect(result.suggestion).toEqual(sampleSuggestion);

    const [request] = api.requests;
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    // SDK 1.x sends the API key as a bearer token.
    expect(request?.headers.get('authorization')).toBe('Bearer sk-ant-test-key');
    expect(request?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request?.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
    expect(request?.body).not.toHaveProperty('betas');
  });

  it('calls Bedrock with the prefixed model id and SigV4 auth, without fallbacks', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    const api = messagesApi('anthropic.claude-opus-5-5');
    const config = loadProcessConfig({
      TRIAGE_PROVIDER: 'bedrock',
      AWS_REGION: 'us-west-2',
    }).triage;

    const model = await createTriageModel(config, { fetch: api.fetch });
    const result = await model.suggest(sampleInput, { signal: signal() });

    expect(model).toMatchObject({ provider: 'bedrock', modelId: 'anthropic.claude-opus-5-5' });
    expect(result.model).toBe('anthropic.claude-opus-5-5');

    const [request] = api.requests;
    expect(request?.url).toMatch(
      /^https:\/\/bedrock-mantle\.us-west-2\.api\.aws\/anthropic\/v1\/messages/,
    );
    expect(request?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request?.body).toMatchObject({ model: 'anthropic.claude-opus-5-5' });
    expect(request?.body).not.toHaveProperty('fallbacks');
  });

  it('uses a configured model id', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    const api = messagesApi('claude-sonnet-5-5');
    const config = loadProcessConfig({
      TRIAGE_PROVIDER: 'anthropic',
      TRIAGE_MODEL: 'claude-sonnet-5-5',
      TRIAGE_EFFORT: 'low',
    }).triage;

    const model = await createTriageModel(config, { fetch: api.fetch });
    await model.suggest(sampleInput, { signal: signal() });

    expect(api.requests[0]?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'low' },
    });
  });
});
