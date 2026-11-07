import type { Priority } from '@issue-triage/shared';

import type { TriageInput, TriageModel, TriageResult, TriageSuggestion } from './model.js';
import { PROMPT_VERSION } from './prompt.js';

type Respond = (input: TriageInput) => TriageSuggestion | Promise<TriageSuggestion>;

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/**
 * A deterministic stand-in for a real model, for tests and for local development without an API
 * key (`TRIAGE_PROVIDER=fake`). By default it applies simple keyword rules; tests can pass
 * `respond` to script exact outputs or failures. It records every input it receives.
 */
export class FakeTriageModel implements TriageModel {
  readonly provider = 'fake';
  readonly modelId = 'fake-triage-model';
  /** The fake doesn't think, so it has no effort level. */
  readonly effort = null;
  /** The fake ignores the prompt; this is only the version it reports. */
  readonly promptVersion: string;
  readonly inputs: TriageInput[] = [];
  readonly #respond: Respond;

  constructor({
    respond = keywordSuggestion,
    promptVersion = PROMPT_VERSION,
  }: { respond?: Respond; promptVersion?: string } = {}) {
    this.#respond = respond;
    this.promptVersion = promptVersion;
  }

  async suggest(input: TriageInput, { signal }: { signal: AbortSignal }): Promise<TriageResult> {
    signal.throwIfAborted();
    this.inputs.push(input);
    const suggestion = await this.#respond(input);
    return { suggestion, model: this.modelId, usage: NO_USAGE, modelCalls: 1, latencyMs: 0 };
  }
}

/** Labels whose name appears in the issue, a priority from alarming words, the top candidate. */
export function keywordSuggestion(input: TriageInput): TriageSuggestion {
  const text = `${input.issue.title}\n${input.issue.body ?? ''}`.toLowerCase();
  const names = input.labels
    .map((label) => label.name)
    .filter((name) => {
      const keyword = name.toLowerCase().replace(/^[^:]*:\s*/, '');
      return keyword.length > 0 && text.includes(keyword);
    })
    .slice(0, 3);
  const level: Priority = /\b(crash|data loss|security|outage|500)\b/.test(text)
    ? 'high'
    : 'medium';
  const [top] = input.candidates;

  return {
    summary: `${input.issue.title} (suggested by the fake model).`,
    labels: { names, confidence: 0.5, rationale: 'Label names that appear in the issue text.' },
    priority: { level, confidence: 0.5, rationale: 'Keyword rule in the fake model.' },
    duplicates: {
      issues: top ? [{ number: top.number, reason: 'Most similar issue by text.' }] : [],
      confidence: 0.3,
      rationale: 'The fake model always picks the most similar candidate.',
    },
  };
}
