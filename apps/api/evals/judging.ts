/**
 * Puts the summary judge to work: builds a judge behind the real-call guard, judges the summaries
 * of a run (or of the calibration set), caches verdicts, and summarizes the scores.
 *
 * Only answered cases with a reference are judged: a refusal or invalid output has no summary,
 * and a case without key points (an exported one) has nothing to grade coverage against.
 *
 * The verdict cache is separate from the triage cache and keyed by what the judge was asked: the
 * judge model, effort, and prompt version, the rendered judge request, and the output schema.
 * It is content-addressed on purpose: the judge never learns who wrote a summary, so two runs
 * that produce the same summary for the same case share one verdict, and changing the model
 * under test doesn't re-judge identical text.
 *
 * Like the runner, a judge failure is split in two. A refusal, a fallback answer, or a reply that
 * fails the schema (`JudgeError`) is something the judge did with the input: it is counted and
 * cached. A timeout, a rate limit, or a server error says nothing about the summary: it goes to
 * the error list and is not cached, so the next run tries again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { serializeError, type SafeError } from '../src/logging.js';
import type { CreateMessage } from '../src/triage/messages-model.js';
import type { TokenUsage } from '../src/triage/model.js';
import { SDK_MAX_RETRIES, SDK_OPEN_TELEMETRY } from '../src/triage/providers.js';
import type { Fixture } from './cases.js';
import { checkRealJudge, type JudgeKind } from './guard.js';
import {
  FakeSummaryJudge,
  JUDGE_CRITERIA,
  JUDGE_EFFORT,
  judgePrompt,
  JudgeError,
  MessagesSummaryJudge,
  verdictJsonSchema,
  type JudgeCriterion,
  type JudgeInput,
  type Score,
  type SummaryJudge,
  type Verdict,
} from './judge.js';
import { costMetrics, type CostMetrics } from './metrics.js';
import { costUsd } from './pricing.js';
import type { RunResult } from './runner.js';

/** Bump when the cached verdict format changes, so old entries miss. */
const JUDGE_CACHE_FORMAT = 1;

export interface JudgeConfig {
  kind: JudgeKind;
  model: string;
  /** Null for the fake judge, which has no effort setting. */
  effort: string | null;
  promptVersion: string;
}

export const judgeConfigOf = (kind: JudgeKind, judge: SummaryJudge): JudgeConfig => ({
  kind,
  model: judge.modelId,
  effort: kind === 'fake' ? null : JUDGE_EFFORT,
  promptVersion: judge.promptVersion,
});

export type CreateJudgeResult = { judge: SummaryJudge } | { refused: string };

/**
 * The judge for `--judge`. A real judge is built only after the guard allows it; `createMessage`
 * replaces the SDK client in tests, so no request leaves the process.
 */
export function createSummaryJudge(
  kind: JudgeKind,
  env: Readonly<Record<string, string | undefined>>,
  { createMessage, timeoutMs = 60_000 }: { createMessage?: CreateMessage; timeoutMs?: number } = {},
): CreateJudgeResult {
  const guard = checkRealJudge(kind, env);
  if (!guard.allowed) {
    return { refused: guard.reason };
  }
  if (kind === 'fake') {
    return { judge: new FakeSummaryJudge() };
  }
  let create = createMessage;
  if (!create) {
    // Reads ANTHROPIC_API_KEY, which the guard required. Never Bedrock: the judge is fixed.
    const client = new Anthropic({
      timeout: timeoutMs,
      maxRetries: SDK_MAX_RETRIES,
      openTelemetry: SDK_OPEN_TELEMETRY,
    });
    create = (params, options) => client.beta.messages.create(params, options);
  }
  return { judge: new MessagesSummaryJudge({ createMessage: create }) };
}

/** One summary to judge, and where it came from. The `where` never reaches the judge. */
export interface JudgeItem {
  id: string;
  input: JudgeInput;
}

export type JudgeOutcome =
  | { status: 'judged'; verdict: Verdict; model: string; promptVersion: string; usage: TokenUsage }
  | { status: 'failed'; message: string; usage: TokenUsage | null };

export interface JudgedItem {
  id: string;
  cacheKey: string;
  cached: boolean;
  outcome: JudgeOutcome;
}

export interface JudgeRun {
  config: JudgeConfig;
  results: JudgedItem[];
  errors: { id: string; error: SafeError }[];
  /** Scored triage outcomes that were not judged: unanswered, or no reference to judge against. */
  skipped: number;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function judgeCacheKey(config: JudgeConfig, input: JudgeInput): string {
  return sha256(
    JSON.stringify({
      format: JUDGE_CACHE_FORMAT,
      kind: config.kind,
      model: config.model,
      effort: config.effort,
      promptVersion: config.promptVersion,
      prompt: judgePrompt(input),
      schema: verdictJsonSchema,
    }),
  );
}

function readCache(dir: string, key: string): JudgeOutcome | null {
  try {
    const entry = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as {
      key?: unknown;
      outcome?: JudgeOutcome;
    };
    return entry.key === key && entry.outcome ? entry.outcome : null;
  } catch {
    return null;
  }
}

function writeCache(dir: string, key: string, outcome: JudgeOutcome): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ key, outcome }, null, 2)}\n`);
  renameSync(temporary, path);
}

/** The summaries of a run that can be judged, with the case's key points. */
export function itemsFromRun(
  run: RunResult,
  fixtures: readonly Fixture[],
): { items: JudgeItem[]; skipped: number } {
  const cases = new Map(
    fixtures.flatMap((fixture) =>
      fixture.cases.map((c) => [`${fixture.repository}/${c.id}`, c] as const),
    ),
  );
  const items: JudgeItem[] = [];
  let skipped = 0;
  for (const result of run.results) {
    const evalCase = cases.get(`${result.repository}/${result.caseId}`);
    const reference = evalCase?.expected.summary;
    if (!evalCase || !reference || result.outcome.status !== 'answered') {
      skipped += 1;
      continue;
    }
    items.push({
      id: `${result.repository}/${result.caseId}#${result.rep}`,
      input: {
        issue: { title: evalCase.issue.title, body: evalCase.issue.body },
        keyPoints: reference.keyPoints,
        summary: result.outcome.suggestion.summary,
      },
    });
  }
  return { items, skipped };
}

export async function judgeItems({
  items,
  judge,
  config,
  cacheDir,
  concurrency = 1,
  skipped = 0,
  signal = new AbortController().signal,
}: {
  items: readonly JudgeItem[];
  judge: SummaryJudge;
  config: JudgeConfig;
  cacheDir?: string;
  concurrency?: number;
  skipped?: number;
  signal?: AbortSignal;
}): Promise<JudgeRun> {
  const results = new Array<JudgedItem | undefined>(items.length);
  const errors = new Array<{ id: string; error: SafeError } | undefined>(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (!item) {
        break;
      }
      signal.throwIfAborted();
      const key = judgeCacheKey(config, item.input);
      const hit = cacheDir === undefined ? null : readCache(cacheDir, key);
      if (hit) {
        results[index] = { id: item.id, cacheKey: key, cached: true, outcome: hit };
        continue;
      }
      let outcome: JudgeOutcome;
      try {
        // Only the judge input goes to the judge: not the item id, not the run's config.
        const result = await judge.judge(item.input, { signal });
        outcome = {
          status: 'judged',
          verdict: result.verdict,
          model: result.model,
          promptVersion: result.promptVersion,
          usage: result.usage,
        };
      } catch (error) {
        if (!(error instanceof JudgeError)) {
          signal.throwIfAborted();
          errors[index] = { id: item.id, error: serializeError(error) };
          continue;
        }
        outcome = { status: 'failed', message: error.message, usage: error.usage };
      }
      if (cacheDir !== undefined) {
        writeCache(cacheDir, key, outcome);
      }
      results[index] = { id: item.id, cacheKey: key, cached: false, outcome };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
  return {
    config,
    results: results.filter((result) => result !== undefined),
    errors: errors.filter((error) => error !== undefined),
    skipped,
  };
}

export interface CriterionScores {
  /** Judged summaries. */
  n: number;
  mean: number | null;
  /** How many summaries got each score, 1 to 5. */
  distribution: Record<Score['score'], number>;
}

export interface JudgeSummary {
  config: JudgeConfig;
  judged: number;
  /** The judge declined, answered from another model, or replied outside the schema. */
  failed: number;
  infraErrors: number;
  cached: number;
  skipped: number;
  scores: Record<JudgeCriterion, CriterionScores>;
  /** The judge's own tokens and cost, apart from the run's. */
  cost: CostMetrics;
}

export function criterionScores(scores: readonly number[]): CriterionScores {
  const distribution: Record<Score['score'], number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const score of scores) {
    distribution[score as Score['score']] += 1;
  }
  return {
    n: scores.length,
    mean: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
    distribution,
  };
}

export function summarizeJudging(run: JudgeRun): JudgeSummary {
  const verdicts = run.results.flatMap(({ outcome }) =>
    outcome.status === 'judged' ? [outcome.verdict] : [],
  );
  const scores = Object.fromEntries(
    JUDGE_CRITERIA.map((criterion) => [
      criterion,
      criterionScores(verdicts.map((verdict) => verdict[criterion].score)),
    ]),
  ) as Record<JudgeCriterion, CriterionScores>;
  return {
    config: run.config,
    judged: verdicts.length,
    failed: run.results.length - verdicts.length,
    infraErrors: run.errors.length,
    cached: run.results.filter((result) => result.cached).length,
    skipped: run.skipped,
    scores,
    cost: costMetrics(
      run.results.map(({ outcome }) => ({
        usageByModel:
          outcome.usage === null ? null : [{ model: run.config.model, usage: outcome.usage }],
      })),
      run.config.kind === 'fake' ? 'local' : 'anthropic',
      costUsd,
    ),
  };
}
