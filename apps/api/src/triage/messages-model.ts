import Anthropic from '@anthropic-ai/sdk';

import {
  InvalidModelOutputError,
  ModelRefusalError,
  TriageModelError,
  type TokenUsage,
  type TriageEffort,
  type TriageInput,
  type TriageModel,
  type TriageResult,
} from './model.js';
import { outputContext, outputJsonSchema, parseSuggestion, type ParseResult } from './output.js';
import { PROMPTS, PROMPT_VERSION, type TriagePrompt } from './prompt.js';

type MessageParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The one SDK call this model makes. Both the Anthropic and the Bedrock client provide it. */
export type CreateMessage = (
  params: MessageParams,
  options: Anthropic.RequestOptions,
) => Promise<Anthropic.Beta.BetaMessage>;

export interface MessagesTriageModelOptions {
  provider: 'anthropic' | 'bedrock';
  modelId: string;
  effort: TriageEffort;
  createMessage: CreateMessage;
  /** The prompt to render. Defaults to the current default version. */
  prompt?: TriagePrompt;
  /** Provider-specific request fields, such as server-side refusal fallbacks. */
  requestExtras?: Partial<MessageParams>;
  /** Monotonic clock in milliseconds, for latency. */
  now?: () => number;
}

/**
 * Room for adaptive thinking plus the JSON reply. Thinking counts toward `max_tokens`, so a
 * limit sized for the reply alone would cut answers off. Effort, not this cap, is what keeps
 * the usual request small.
 */
const MAX_TOKENS = 16_000;

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

function addUsage(total: TokenUsage, usage: Anthropic.Beta.BetaUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + usage.input_tokens,
    outputTokens: total.outputTokens + usage.output_tokens,
    cacheReadInputTokens: total.cacheReadInputTokens + (usage.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + (usage.cache_creation_input_tokens ?? 0),
  };
}

/**
 * The reply text. With server-side fallbacks, a `fallback` block marks where another model took
 * over after a refusal, and only the text after the last one belongs to the final answer.
 */
function replyText(content: readonly Anthropic.Beta.BetaContentBlock[]): string {
  const start = content.findLastIndex((block) => block.type === 'fallback') + 1;
  return content
    .slice(start)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const seconds = Number(headers?.get('retry-after'));
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Maps SDK errors to retryable or permanent triage failures. The SDK has already retried
 * transient errors a couple of times by then; these decide whether the job queue tries again
 * later. Authentication, permission, unknown-model, and malformed-request errors are permanent:
 * retrying cannot fix configuration.
 */
function toTriageError(error: unknown): unknown {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIUserAbortError) {
    return error;
  }
  const request = error.requestID ? ` (request ${error.requestID})` : '';
  const message = `Model request failed: ${error.message}${request}`;
  if (error instanceof Anthropic.APIConnectionError) {
    // Includes APIConnectionTimeoutError: the request timed out after the SDK's retries.
    return new TriageModelError(message, { retryable: true, cause: error });
  }
  const retryable =
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.RequestTimeoutError ||
    error instanceof Anthropic.ConflictError;
  const delay = retryAfterMs(error.headers as Headers | undefined);
  return new TriageModelError(message, {
    retryable,
    ...(delay !== undefined && { retryAfterMs: delay }),
    cause: error,
  });
}

/**
 * Triage through the Claude Messages API with structured output. Used for both the Anthropic API
 * and Amazon Bedrock, which serve the same API through different clients.
 *
 * If the output fails validation, the model gets one more turn: its own reply plus the list of
 * problems. If that also fails, the job fails with {@link InvalidModelOutputError}; output that
 * failed validation is never returned, so labels outside the repository's set cannot get through.
 */
export class MessagesTriageModel implements TriageModel {
  readonly provider: 'anthropic' | 'bedrock';
  readonly modelId: string;
  readonly effort: TriageEffort;
  readonly promptVersion: string;
  readonly #prompt: TriagePrompt;
  readonly #createMessage: CreateMessage;
  readonly #requestExtras: Partial<MessageParams>;
  readonly #now: () => number;

  constructor(options: MessagesTriageModelOptions) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.effort = options.effort;
    this.#prompt = options.prompt ?? PROMPTS[PROMPT_VERSION];
    this.promptVersion = this.#prompt.version;
    this.#createMessage = options.createMessage;
    this.#requestExtras = options.requestExtras ?? {};
    this.#now = options.now ?? (() => performance.now());
  }

  async suggest(input: TriageInput, { signal }: { signal: AbortSignal }): Promise<TriageResult> {
    const context = outputContext(input);
    const [instructions, repository] = this.#prompt.systemPrompt(input);
    const request: Omit<MessageParams, 'messages'> = {
      ...this.#requestExtras,
      model: this.modelId,
      max_tokens: MAX_TOKENS,
      // Thinking is left at the model default (adaptive on current models); effort sets its depth.
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: outputJsonSchema(context.labelNames) },
      },
      system: [
        { type: 'text', text: instructions },
        // Instructions and labels are the same for every issue in the repository: cache them.
        { type: 'text', text: repository, cache_control: { type: 'ephemeral' } },
      ],
    };
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: this.#prompt.userMessage(input) },
    ];

    let usage = NO_USAGE;
    let latencyMs = 0;
    let problems: string[] = [];
    for (let call = 1; call <= 2; call += 1) {
      const started = this.#now();
      const response = await this.#send({ ...request, messages }, signal);
      latencyMs += this.#now() - started;
      usage = addUsage(usage, response.usage);

      if (response.stop_reason === 'refusal') {
        throw new ModelRefusalError(response.stop_details?.category ?? null);
      }
      const result: ParseResult =
        response.stop_reason === 'max_tokens'
          ? { success: false, problems: ['the reply was cut off at the output limit'] }
          : parseSuggestion(replyText(response.content), context);
      if (result.success) {
        return {
          suggestion: result.suggestion,
          model: response.model,
          usage,
          modelCalls: call,
          latencyMs: Math.round(latencyMs),
        };
      }

      problems = result.problems;
      // Append-only: the reply goes back unchanged (thinking blocks included), then the fix-up.
      messages.push(
        { role: 'assistant', content: response.content },
        { role: 'user', content: this.#prompt.correctionMessage(problems) },
      );
    }
    throw new InvalidModelOutputError(problems);
  }

  async #send(params: MessageParams, signal: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await this.#createMessage(params, { signal });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw toTriageError(error);
    }
  }
}
