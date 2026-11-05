import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { MessagesTriageModel, type CreateMessage } from '../../src/triage/messages-model.js';
import {
  InvalidModelOutputError,
  ModelRefusalError,
  TriageModelError,
} from '../../src/triage/model.js';
import { sampleInput, sampleSuggestion } from '../helpers/triage.js';

type Message = Anthropic.Beta.BetaMessage;

/** A response as the Messages API returns it, with only the fields this code reads filled in. */
function reply(
  text: string,
  overrides: { stop_reason?: Message['stop_reason']; content?: unknown[]; model?: string } = {},
): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5-5',
    content: overrides.content ?? [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text, citations: null },
    ],
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message;
}

const valid = JSON.stringify(sampleSuggestion);
const withForeignLabel = JSON.stringify({
  ...sampleSuggestion,
  labels: { ...sampleSuggestion.labels, names: ['bug', 'priority: p0'] },
});

function setup(...responses: (Message | Error)[]) {
  const createMessage = vi.fn<CreateMessage>(() => {
    const next = responses.shift();
    if (!next) {
      throw new Error('No more scripted responses');
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  let clock = 0;
  const model = new MessagesTriageModel({
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'medium',
    createMessage,
    requestExtras: { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
    now: () => (clock += 250),
  });
  const suggest = () => model.suggest(sampleInput, { signal: new AbortController().signal });
  const request = (call: number) => {
    const params = createMessage.mock.calls[call]?.[0];
    if (!params) {
      throw new Error(`No request ${call}`);
    }
    return params;
  };
  return { createMessage, suggest, request };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('MessagesTriageModel', () => {
  it('sends a structured-output request with a cacheable system prompt', async () => {
    const { suggest, request, createMessage } = setup(reply(valid));

    await suggest();

    const params = request(0);
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
    expect(params.system).toEqual([
      { type: 'text', text: expect.stringMatching(/untrusted text/) as string },
      {
        type: 'text',
        text: expect.stringContaining('lumen-labs/lumen') as string,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(params.messages).toEqual([
      { role: 'user', content: expect.stringContaining('<issue>') as string },
    ]);
    expect(JSON.stringify(params.output_config?.format)).toContain(
      '"enum":["bug","area: export","documentation"]',
    );
    expect(createMessage.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the validated suggestion with the serving model, usage, and latency', async () => {
    const { suggest } = setup(reply(valid, { model: 'claude-opus-5-5' }));

    expect(await suggest()).toEqual({
      suggestion: sampleSuggestion,
      model: 'claude-opus-5-5',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
      },
      modelCalls: 1,
      latencyMs: 250,
    });
  });

  it('retries once with the validation problems, then returns the corrected output', async () => {
    const first = reply(withForeignLabel);
    const { suggest, request, createMessage } = setup(first, reply(valid));

    const result = await suggest();

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(result.suggestion.labels.names).toEqual(['bug', 'area: export']);
    expect(result.modelCalls).toBe(2);
    expect(result.usage.inputTokens).toBe(2400);
    expect(result.latencyMs).toBe(500);

    // The retry appends to the conversation: the original reply, unchanged, then the problems.
    const retry = request(1);
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[0]).toEqual(request(0).messages[0]);
    expect(retry.messages[1]).toEqual({ role: 'assistant', content: first.content });
    expect(retry.messages[2]).toEqual({
      role: 'user',
      content: expect.stringContaining(
        `labels.names.1: "priority: p0" is not one of the repository's labels`,
      ) as string,
    });
    expect(retry.system).toEqual(request(0).system);
  });

  it('fails cleanly, and never returns a foreign label, when the retry is invalid too', async () => {
    const { suggest, createMessage } = setup(reply(withForeignLabel), reply(withForeignLabel));

    const error = await rejection(suggest());

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(InvalidModelOutputError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as InvalidModelOutputError).problems).toEqual([
      `labels.names.1: "priority: p0" is not one of the repository's labels`,
    ]);
  });

  it('treats a reply cut off at max_tokens as invalid', async () => {
    const { suggest, request } = setup(
      reply('{"summary": "PDF export', { stop_reason: 'max_tokens' }),
      reply(valid),
    );

    expect((await suggest()).modelCalls).toBe(2);
    expect(request(1).messages[2]?.content).toMatch(/cut off at the output limit/);
  });

  it('does not retry a refusal', async () => {
    const refusal = {
      ...reply('', { stop_reason: 'refusal', content: [] }),
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
    } as unknown as Message;
    const { suggest, createMessage } = setup(refusal);

    const error = await rejection(suggest());

    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toContain('cyber');
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('reads the answer after a server-side fallback took over', async () => {
    const { suggest } = setup(
      reply('', {
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: '{"summary": "partial', citations: null },
          {
            type: 'fallback',
            from: { model: 'claude-opus-5-5' },
            to: { model: 'claude-opus-4-8' },
          },
          { type: 'text', text: valid, citations: null },
        ],
      }),
    );

    expect(await suggest()).toMatchObject({
      suggestion: sampleSuggestion,
      model: 'claude-opus-4-8',
      modelCalls: 1,
    });
  });

  describe('provider errors', () => {
    const headers = (values: Record<string, string> = {}) =>
      new Headers({ 'request-id': 'req_test', ...values });
    const body = (type: string) => ({ type: 'error', error: { type, message: type } });

    it.each([
      [
        'rate limited',
        new Anthropic.RateLimitError(429, body('rate_limit_error'), undefined, headers()),
        true,
      ],
      [
        'overloaded',
        new Anthropic.InternalServerError(529, body('overloaded_error'), undefined, headers()),
        true,
      ],
      [
        'server error',
        new Anthropic.InternalServerError(500, body('api_error'), undefined, headers()),
        true,
      ],
      ['timed out', new Anthropic.APIConnectionTimeoutError(), true],
      ['connection lost', new Anthropic.APIConnectionError({ message: 'socket hang up' }), true],
      [
        'bad request',
        new Anthropic.BadRequestError(400, body('invalid_request_error'), undefined, headers()),
        false,
      ],
      [
        'unauthenticated',
        new Anthropic.AuthenticationError(401, body('authentication_error'), undefined, headers()),
        false,
      ],
      [
        'unknown model',
        new Anthropic.NotFoundError(404, body('not_found_error'), undefined, headers()),
        false,
      ],
    ])('maps %s to retryable: %s', async (_name, sdkError, retryable) => {
      const { suggest } = setup(sdkError);

      const error = await rejection(suggest());

      expect(error).toBeInstanceOf(TriageModelError);
      expect(error).toMatchObject({ retryable, cause: sdkError });
    });

    it('carries the request id and Retry-After', async () => {
      const { suggest } = setup(
        new Anthropic.RateLimitError(
          429,
          body('rate_limit_error'),
          undefined,
          headers({ 'retry-after': '30' }),
        ),
      );

      const error = await rejection(suggest());

      expect(error).toMatchObject({ retryAfterMs: 30_000 });
      expect((error as Error).message).toContain('req_test');
    });

    it('rejects with the abort reason when the caller aborts', async () => {
      const controller = new AbortController();
      const model = new MessagesTriageModel({
        provider: 'bedrock',
        modelId: 'anthropic.claude-opus-5-5',
        effort: 'medium',
        createMessage: () => {
          controller.abort(new Error('shutting down'));
          return Promise.reject(new Anthropic.APIUserAbortError());
        },
      });

      const error = await rejection(model.suggest(sampleInput, { signal: controller.signal }));

      expect(error).toMatchObject({ message: 'shutting down' });
      expect(error).not.toBeInstanceOf(TriageModelError);
    });
  });
});
