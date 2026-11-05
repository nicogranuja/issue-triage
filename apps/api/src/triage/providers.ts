import Anthropic from '@anthropic-ai/sdk';

import type { TriageConfig } from '../config.js';
import { FakeTriageModel } from './fake-model.js';
import { MessagesTriageModel } from './messages-model.js';
import type { TriageModel } from './model.js';

/**
 * Server-side refusal fallback (Anthropic API only). If the model's safety classifiers decline a
 * benign issue, for example a security bug report, the API re-runs the request on the fallback
 * model Anthropic recommends for that refusal category, instead of failing the job. The model
 * that actually answered is recorded on the suggestion.
 */
const ANTHROPIC_REQUEST_EXTRAS: Partial<Anthropic.Beta.MessageCreateParamsNonStreaming> = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

/** The SDK's own retries for 429s, 5xx, and connection errors, before the job queue's. */
const SDK_MAX_RETRIES = 2;

/**
 * Builds the triage model selected by `TRIAGE_PROVIDER`. Credentials are not passed in: the
 * Anthropic client reads `ANTHROPIC_API_KEY` from the environment, and the Bedrock client uses
 * the AWS credential chain (environment, profile, or instance role), when the first request
 * is made.
 */
export async function createTriageModel(
  config: TriageConfig,
  /** For tests: replaces the SDK's HTTP transport, so no request leaves the process. */
  { fetch }: { fetch?: typeof globalThis.fetch } = {},
): Promise<TriageModel> {
  const transport = fetch ? { fetch } : {};
  switch (config.provider) {
    case 'fake':
      return new FakeTriageModel();

    case 'anthropic': {
      const client = new Anthropic({
        timeout: config.modelTimeoutMs,
        maxRetries: SDK_MAX_RETRIES,
        ...transport,
      });
      return new MessagesTriageModel({
        provider: 'anthropic',
        modelId: config.model,
        effort: config.effort,
        createMessage: (params, options) => client.beta.messages.create(params, options),
        requestExtras: ANTHROPIC_REQUEST_EXTRAS,
      });
    }

    case 'bedrock': {
      // Loaded on demand: the AWS SDK it brings is only needed when Bedrock is selected.
      const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
      const client = new AnthropicBedrockMantle({
        awsRegion: config.awsRegion,
        timeout: config.modelTimeoutMs,
        maxRetries: SDK_MAX_RETRIES,
        ...transport,
      });
      return new MessagesTriageModel({
        provider: 'bedrock',
        modelId: config.model,
        effort: config.effort,
        createMessage: (params, options) => client.beta.messages.create(params, options),
      });
    }
  }
}
