import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadFixtures } from '../../evals/cases.js';
import { checkRealJudge } from '../../evals/guard.js';
import {
  FakeSummaryJudge,
  JUDGE_MODEL,
  JudgeError,
  MessagesSummaryJudge,
  type JudgeInput,
  type SummaryJudge,
} from '../../evals/judge.js';
import {
  createSummaryJudge,
  criterionScores,
  itemsFromRun,
  judgeCacheKey,
  judgeConfigOf,
  judgeItems,
  summarizeJudging,
} from '../../evals/judging.js';
import { runEval } from '../../evals/runner.js';
import { FakeTriageModel } from '../../src/triage/fake-model.js';
import type { CreateMessage } from '../../src/triage/messages-model.js';
import { TriageModelError } from '../../src/triage/model.js';

const fixtures = loadFixtures();

const directories: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-triage-judge-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const input: JudgeInput = {
  issue: { title: 'Export to PDF crashes', body: 'Exporting a 200-page note crashes the app.' },
  keyPoints: ['PDF export crashes', 'Large notes (200 pages)'],
  summary: 'Exporting a note of 200 pages to PDF crashes the app.',
};

describe('the judge guard', () => {
  const everything = { EVAL_REAL_CALLS: '1', ANTHROPIC_API_KEY: 'sk-ant-placeholder' };

  it.each([
    ['tests', { ...everything, VITEST: 'true' }, 'tests or CI'],
    ['CI', { ...everything, CI: 'true' }, 'tests or CI'],
    ['an AI coding agent session', { ...everything, CLAUDECODE: '1' }, 'CLAUDECODE'],
    ['no opt-in', { ANTHROPIC_API_KEY: 'sk-ant-placeholder' }, 'EVAL_REAL_CALLS=1'],
    ['no key', { EVAL_REAL_CALLS: '1' }, 'ANTHROPIC_API_KEY'],
  ])('refuses a real judge from %s, whatever else is set', (_, env, reason) => {
    const refused = checkRealJudge('anthropic', env);
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? '' : refused.reason).toContain(reason);
    const created = createSummaryJudge('anthropic', env, { createMessage: vi.fn() });
    expect(created).toHaveProperty('refused');
  });

  it('refuses a real judge in this very test process', () => {
    // Vitest sets VITEST, so the real environment can never build a real judge here.
    expect(checkRealJudge('anthropic', { ...process.env, ...everything })).toMatchObject({
      allowed: false,
    });
  });

  it('builds the fake judge with nothing set, and a real one only with both opt-ins', () => {
    const fake = createSummaryJudge('fake', {});
    expect('judge' in fake && fake.judge).toBeInstanceOf(FakeSummaryJudge);
    const createMessage = vi.fn<CreateMessage>();
    const real = createSummaryJudge('anthropic', everything, { createMessage });
    expect('judge' in real && real.judge).toBeInstanceOf(MessagesSummaryJudge);
    expect('judge' in real && real.judge.modelId).toBe(JUDGE_MODEL);
    // Building it makes no call.
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('judging a run', () => {
  it('judges every answered case with a reference, showing the judge only the judge input', async () => {
    const run = await runEval({
      fixtures,
      model: new FakeTriageModel(),
      config: {
        provider: 'fake',
        model: 'fake-triage-model',
        effort: null,
        promptVersion: 'triage-v1',
        reps: 1,
        seed: 0,
      },
    });
    const { items, skipped } = itemsFromRun(run, fixtures);
    expect(items.length + skipped).toBe(run.results.length);
    expect(items.length).toBeGreaterThan(0);

    const judge = new FakeSummaryJudge();
    const judged = await judgeItems({ items, judge, config: judgeConfigOf('fake', judge) });
    expect(judged.results).toHaveLength(items.length);
    for (const shown of judge.inputs) {
      expect(Object.keys(shown)).toEqual(['issue', 'keyPoints', 'summary']);
      expect(Object.keys(shown.issue)).toEqual(['title', 'body']);
    }
    const summary = summarizeJudging(judged);
    expect(summary.judged).toBe(items.length);
    expect(summary.config).toEqual({
      kind: 'fake',
      model: 'fake-judge',
      effort: null,
      promptVersion: 'judge-v1',
    });
    const { distribution } = summary.scores.coverage;
    expect(Object.values(distribution).reduce((a, b) => a + b, 0)).toBe(items.length);
    // The fake judge makes no call: zero tokens, zero cost.
    expect(summary.cost.totalUsd).toBe(0);
  });

  it('reports the judge cost apart, at the judge model rates', async () => {
    const judge: SummaryJudge = {
      modelId: JUDGE_MODEL,
      promptVersion: 'judge-v1',
      judge: () =>
        Promise.resolve({
          verdict: {
            faithfulness: { score: 5, rationale: 'r' },
            coverage: { score: 3, rationale: 'r' },
            concision: { score: 4, rationale: 'r' },
          },
          model: JUDGE_MODEL,
          promptVersion: 'judge-v1',
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }),
    };
    const judged = await judgeItems({
      items: [{ id: 'a', input }],
      judge,
      config: judgeConfigOf('anthropic', judge),
    });
    // claude-sonnet-5-5: $2 per MTok in, $10 out.
    expect(summarizeJudging(judged).cost.totalUsd).toBeCloseTo(2 + 1, 10);
  });

  it('computes the mean and the distribution per criterion', () => {
    expect(criterionScores([1, 2, 2, 5])).toEqual({
      n: 4,
      mean: 2.5,
      distribution: { 1: 1, 2: 2, 3: 0, 4: 0, 5: 1 },
    });
    expect(criterionScores([]).mean).toBeNull();
  });
});

describe('the judge cache', () => {
  function countingJudge(fail?: Error): SummaryJudge & { calls: number } {
    const fake = new FakeSummaryJudge();
    const judge = {
      modelId: 'counting-judge',
      promptVersion: 'judge-v1',
      calls: 0,
      judge(i: JudgeInput, options: { signal: AbortSignal }) {
        judge.calls += 1;
        return fail ? Promise.reject(fail) : fake.judge(i, options);
      },
    };
    return judge;
  }

  it('answers a repeated judgment without calling the judge', async () => {
    const cacheDir = tempDir();
    const judge = countingJudge();
    const config = judgeConfigOf('anthropic', judge);
    const items = [
      { id: 'a', input },
      { id: 'b', input: { ...input, summary: 'Another summary.' } },
    ];
    const first = await judgeItems({ items, judge, config, cacheDir });
    const second = await judgeItems({ items, judge, config, cacheDir });
    expect(judge.calls).toBe(2);
    expect(second.results.every((result) => result.cached)).toBe(true);
    expect(second.results.map((r) => r.outcome)).toEqual(first.results.map((r) => r.outcome));
    expect(readdirSync(cacheDir)).toHaveLength(2);
  });

  it('keys on the judge config and the judge input, not on who wrote the summary', () => {
    const judge = countingJudge();
    const config = judgeConfigOf('anthropic', judge);
    const key = judgeCacheKey(config, input);
    expect(judgeCacheKey({ ...config, promptVersion: 'judge-v2' }, input)).not.toBe(key);
    expect(judgeCacheKey({ ...config, model: 'claude-opus-5-5' }, input)).not.toBe(key);
    expect(judgeCacheKey({ ...config, effort: 'low' }, input)).not.toBe(key);
    expect(judgeCacheKey(config, { ...input, summary: 'Other.' })).not.toBe(key);
    expect(judgeCacheKey(config, { ...input, keyPoints: ['Other'] })).not.toBe(key);
    expect(judgeCacheKey(config, { ...input })).toBe(key);
  });

  it('caches a judge failure, but not an infrastructure error', async () => {
    const cacheDir = tempDir();
    const failing = countingJudge(new JudgeError('The judge declined', null));
    const config = judgeConfigOf('anthropic', failing);
    const failed = await judgeItems({
      items: [{ id: 'a', input }],
      judge: failing,
      config,
      cacheDir,
    });
    expect(failed.results[0]?.outcome).toMatchObject({ status: 'failed' });
    expect(summarizeJudging(failed)).toMatchObject({ judged: 0, failed: 1 });
    await judgeItems({ items: [{ id: 'a', input }], judge: failing, config, cacheDir });
    expect(failing.calls).toBe(1);

    const otherDir = tempDir();
    const broken = countingJudge(new TriageModelError('rate limited', { retryable: true }));
    const errored = await judgeItems({
      items: [{ id: 'a', input }],
      judge: broken,
      config,
      cacheDir: otherDir,
    });
    expect(errored.results).toEqual([]);
    expect(errored.errors).toHaveLength(1);
    expect(readdirSync(otherDir)).toEqual([]);
  });
});
