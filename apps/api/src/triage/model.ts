import type { IssueState, Priority } from '@issue-triage/shared';

/** Where triage suggestions come from. Chosen with `TRIAGE_PROVIDER`. */
export const TRIAGE_PROVIDERS = ['anthropic', 'bedrock', 'fake'] as const;
export type TriageProvider = (typeof TRIAGE_PROVIDERS)[number];

/** Effort levels of the Messages API: how much the model thinks before answering. */
export const TRIAGE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type TriageEffort = (typeof TRIAGE_EFFORTS)[number];

/** Everything the model sees about one issue. */
export interface TriageInput {
  /** `owner/name` */
  repository: string;
  issue: { number: number; title: string; body: string | null };
  /** The repository's labels: the only ones a suggestion may use. */
  labels: readonly { name: string; description: string | null }[];
  /** Existing issues that the pre-filter found similar, most similar first. */
  candidates: readonly { number: number; title: string; state: IssueState; excerpt: string }[];
}

interface Judgement {
  /** How likely a maintainer agrees, from 0 to 1. */
  confidence: number;
  /** One sentence on why, shown to the reviewer. */
  rationale: string;
}

/** A validated suggestion, in the shape the model is asked to produce. */
export interface TriageSuggestion {
  summary: string;
  labels: Judgement & { names: string[] };
  priority: Judgement & { level: Priority };
  duplicates: Judgement & { issues: { number: number; reason: string }[] };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface TriageResult {
  suggestion: TriageSuggestion;
  /** The model that produced the suggestion, as reported by the provider. */
  model: string;
  /** Summed over all model calls for this suggestion. */
  usage: TokenUsage;
  /** 1, or 2 when the first output failed validation and the model was asked to correct it. */
  modelCalls: number;
  /** Time spent waiting for the model, summed over calls. */
  latencyMs: number;
}

/** A source of triage suggestions. Implementations: Anthropic API, Amazon Bedrock, and a fake. */
export interface TriageModel {
  readonly provider: TriageProvider;
  /** The configured model id, as sent to the provider. */
  readonly modelId: string;
  /** The effort level sent with every request, or null when the provider has none. */
  readonly effort: TriageEffort | null;
  /** The prompt this model renders (see `prompt.ts`), stored on every suggestion. */
  readonly promptVersion: string;
  /**
   * Suggests triage for one issue. Rejects with a {@link TriageModelError} when the provider
   * fails or its output cannot be used, and with the signal's reason when `signal` aborts.
   */
  suggest(input: TriageInput, options: { signal: AbortSignal }): Promise<TriageResult>;
}

/** A failure to get a usable suggestion. `retryable` says whether a later attempt could help. */
export class TriageModelError extends Error {
  override name = 'TriageModelError';
  readonly retryable: boolean;
  /** How long the provider asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    {
      retryable,
      retryAfterMs,
      cause,
    }: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause });
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The model's output failed validation twice: once, then again after being shown the problems. */
export class InvalidModelOutputError extends TriageModelError {
  override name = 'InvalidModelOutputError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Model output failed validation after a retry: ${problems.join('; ')}`, {
      retryable: false,
    });
    this.problems = problems;
  }
}

/** The model declined the request (`stop_reason: refusal`). Retrying the same input won't help. */
export class ModelRefusalError extends TriageModelError {
  override name = 'ModelRefusalError';

  constructor(category: string | null) {
    super(`The model declined to triage this issue (category: ${category ?? 'unspecified'})`, {
      retryable: false,
    });
  }
}
