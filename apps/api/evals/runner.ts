/**
 * Runs a `TriageModel` over the eval cases. Every result is re-checked with `suggestionSchema`
 * (the same check the worker relies on), so a provider bug can't score output the worker would
 * never accept.
 *
 * Each case ends in one of two places:
 *
 * - a scored outcome: an answer, a refusal, or invalid output. These are what the model did with
 *   the input, so they count in the report (as answers or as failure rates) and are cached;
 * - an infrastructure error: a timeout, a rate limit, a 5xx, a bad API key. These say nothing
 *   about the model, so they go to the errors sidecar, are left out of every score, and are not
 *   cached (the next run tries those cases again).
 *
 * The cache key is a hash of the case, the exact model input, and the configuration: provider,
 * model, effort, prompt version, the rendered prompt, the rep, and the seed. Changing any of them
 * misses the cache.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { serializeError, type SafeError } from '../src/logging.js';
import {
  InvalidModelOutputError,
  ModelRefusalError,
  type ModelUsage,
  type TokenUsage,
  type TriageInput,
  type TriageModel,
  type TriageSuggestion,
} from '../src/triage/model.js';
import { outputContext, outputJsonSchema, suggestionSchema } from '../src/triage/output.js';
import { isPromptVersion, promptFor } from '../src/triage/prompt.js';
import { triageInputFor, type EvalCase, type Fixture } from './cases.js';

/**
 * Bump when the cached outcome format changes, so old entries miss. 2: outcomes record per-model
 * usage and the fallback flag; a format-1 entry can't say whether a fallback answered, so its
 * cost and fallback rate would be wrong.
 */
const CACHE_FORMAT = 2;

/** What a run is: which model, and how it is sampled. All of it is part of the cache key. */
export interface RunConfig {
  /** `fake`, `oracle`, `null`, `anthropic`, or `bedrock`. */
  provider: string;
  model: string;
  effort: string | null;
  promptVersion: string;
  /** Times each case is run. Each rep has its own cache entry. */
  reps: number;
  /**
   * Part of the cache key only: the API takes no seed, so a new seed is how a run asks for fresh
   * samples instead of cached ones.
   */
  seed: number;
}

export type ScoredOutcome =
  | {
      status: 'answered';
      suggestion: TriageSuggestion;
      /** The model that answered, as the provider reported it. */
      model: string;
      usage: TokenUsage;
      /** Every attempt's tokens by model (see `TriageResult`). Absent: `usage` is the total. */
      usageByModel?: ModelUsage[];
      /** A server-side fallback model answered. Absent: the provider can't tell. */
      fallback?: boolean;
      modelCalls: number;
      latencyMs: number;
    }
  | { status: 'refused'; message: string; usageByModel?: ModelUsage[] }
  | {
      status: 'invalid';
      /** Where the output failed: the provider's own check, or the runner's re-check. */
      stage: 'provider' | 'recheck';
      problems: string[];
      /** What the calls used. Absent when the provider didn't say. */
      usageByModel?: ModelUsage[];
    };

export interface CaseResult {
  repository: string;
  caseId: string;
  rep: number;
  cacheKey: string;
  cached: boolean;
  outcome: ScoredOutcome;
}

/** An infrastructure failure: written to the sidecar, never scored. */
export interface InfraError {
  repository: string;
  caseId: string;
  rep: number;
  error: SafeError;
}

export interface RunResult {
  config: RunConfig;
  results: CaseResult[];
  errors: InfraError[];
}

export interface RunOptions {
  fixtures: readonly Fixture[];
  model: TriageModel;
  config: RunConfig;
  /** Where cached outcomes live. Omit to run without a cache. */
  cacheDir?: string;
  /** Cases in flight at once. */
  concurrency?: number;
  signal?: AbortSignal;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What the model sees for an input under a prompt version: system blocks, user turn, schema. */
function renderedPrompt(promptVersion: string, input: TriageInput) {
  if (!isPromptVersion(promptVersion)) {
    // Baselines can report any version; only a released one renders.
    return null;
  }
  const prompt = promptFor(promptVersion);
  return {
    system: prompt.systemPrompt(input),
    user: prompt.userMessage(input),
    schema: outputJsonSchema(input.labels.map((label) => label.name)),
  };
}

export function cacheKey(
  fixture: Fixture,
  evalCase: EvalCase,
  input: TriageInput,
  config: RunConfig,
  rep: number,
): string {
  return sha256(
    JSON.stringify({
      format: CACHE_FORMAT,
      repository: fixture.repository,
      case: evalCase,
      input,
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      promptVersion: config.promptVersion,
      prompt: renderedPrompt(config.promptVersion, input),
      rep,
      seed: config.seed,
    }),
  );
}

/** A cached outcome, re-checked like a fresh one. Anything unreadable is a miss. */
function readCache(dir: string, key: string, input: TriageInput): ScoredOutcome | null {
  let entry: { key?: unknown; outcome?: ScoredOutcome };
  try {
    entry = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as typeof entry;
  } catch {
    return null;
  }
  if (entry.key !== key || !entry.outcome) {
    return null;
  }
  return entry.outcome.status === 'answered' ? recheck(entry.outcome, input) : entry.outcome;
}

function writeCache(dir: string, key: string, outcome: ScoredOutcome): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ key, outcome }, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Validates an answer against the case's labels and candidates, as the worker would. */
function recheck(
  outcome: Extract<ScoredOutcome, { status: 'answered' }>,
  input: TriageInput,
): ScoredOutcome {
  const parsed = suggestionSchema(outputContext(input)).safeParse(outcome.suggestion);
  if (!parsed.success) {
    return {
      status: 'invalid',
      stage: 'recheck',
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      // The calls were made and billed, whatever the re-check says.
      usageByModel: outcome.usageByModel ?? [{ model: outcome.model, usage: outcome.usage }],
    };
  }
  return { ...outcome, suggestion: parsed.data };
}

type Attempt = { outcome: ScoredOutcome } | { error: unknown };

async function attempt(model: TriageModel, input: TriageInput, signal: AbortSignal) {
  try {
    const result = await model.suggest(input, { signal });
    return {
      outcome: recheck(
        {
          status: 'answered',
          suggestion: result.suggestion,
          model: result.model,
          usage: result.usage,
          ...(result.usageByModel !== undefined && { usageByModel: result.usageByModel }),
          ...(result.fallback !== undefined && { fallback: result.fallback }),
          modelCalls: result.modelCalls,
          latencyMs: result.latencyMs,
        },
        input,
      ),
    } satisfies Attempt;
  } catch (error) {
    if (error instanceof ModelRefusalError) {
      return {
        outcome: {
          status: 'refused',
          message: error.message,
          ...(error.usageByModel && { usageByModel: [...error.usageByModel] }),
        },
      } satisfies Attempt;
    }
    if (error instanceof InvalidModelOutputError) {
      return {
        outcome: {
          status: 'invalid',
          stage: 'provider',
          problems: [...error.problems],
          ...(error.usageByModel && { usageByModel: [...error.usageByModel] }),
        },
      } satisfies Attempt;
    }
    // Everything else (timeouts, rate limits, auth, a crash in the provider) is infrastructure.
    return { error } satisfies Attempt;
  }
}

export async function runEval({
  fixtures,
  model,
  config,
  cacheDir,
  concurrency = 1,
  signal = new AbortController().signal,
}: RunOptions): Promise<RunResult> {
  const jobs = fixtures.flatMap((fixture) =>
    fixture.cases.flatMap((evalCase) =>
      Array.from({ length: config.reps }, (_, rep) => ({ fixture, evalCase, rep })),
    ),
  );
  const results = new Array<CaseResult | undefined>(jobs.length);
  const errors = new Array<InfraError | undefined>(jobs.length);

  let next = 0;
  const work = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      if (!job) {
        break;
      }
      const { fixture, evalCase, rep } = job;
      signal.throwIfAborted();
      const input = triageInputFor(fixture, evalCase);
      const key = cacheKey(fixture, evalCase, input, config, rep);
      const where = { repository: fixture.repository, caseId: evalCase.id, rep };

      const hit = cacheDir === undefined ? null : readCache(cacheDir, key, input);
      if (hit) {
        results[index] = { ...where, cacheKey: key, cached: true, outcome: hit };
        continue;
      }
      const tried = await attempt(model, input, signal);
      if ('error' in tried) {
        // An abort ends the run instead of filling the sidecar with every remaining case.
        signal.throwIfAborted();
        errors[index] = { ...where, error: serializeError(tried.error) };
        continue;
      }
      if (cacheDir !== undefined) {
        writeCache(cacheDir, key, tried.outcome);
      }
      results[index] = { ...where, cacheKey: key, cached: false, outcome: tried.outcome };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));

  return {
    config,
    results: results.filter((result) => result !== undefined),
    errors: errors.filter((error) => error !== undefined),
  };
}
