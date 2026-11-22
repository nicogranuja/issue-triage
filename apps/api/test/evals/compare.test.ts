import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PairedInterval } from '../../evals/bootstrap.js';
import { loadFixtures } from '../../evals/cases.js';
import { main } from '../../evals/cli.js';
import {
  caseValues,
  compareMetrics,
  comparisonNotice,
  MIN_PAIRED_CASES,
  pairwisePreference,
  warningsFor,
  type ComparisonReport,
} from '../../evals/compare.js';
import type { PairVerdict } from '../../evals/pairwise.js';
import type { RunConfig, RunResult } from '../../evals/runner.js';
import type { CreateMessage } from '../../src/triage/messages-model.js';

const directories: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-triage-compare-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const noLog = () => undefined;
const now = () => new Date('2026-11-22T12:00:00Z');
const interval = (overrides: Partial<PairedInterval>): PairedInterval => ({
  n: 40,
  delta: 0.2,
  a: 0.5,
  b: 0.7,
  low: 0.1,
  high: 0.3,
  level: 0.95,
  seed: 0,
  resamples: 10_000,
  undefinedResamples: 0,
  ...overrides,
});

describe('warningsFor', () => {
  it('is empty only for enough cases and an interval that excludes 0', () => {
    expect(warningsFor(interval({}))).toEqual([]);
    expect(warningsFor(interval({ low: -0.3, high: -0.1, delta: -0.2 }))).toEqual([]);
  });

  it('warns when the interval includes 0, touching it included', () => {
    for (const [low, high] of [
      [-0.1, 0.2],
      [0, 0.2],
      [-0.2, 0],
      [0, 0],
    ] as const) {
      expect(warningsFor(interval({ low, high })).join(' ')).toMatch(/includes 0/);
    }
  });

  it(`warns below ${MIN_PAIRED_CASES} paired cases, even when the interval excludes 0`, () => {
    const small = warningsFor(interval({ n: MIN_PAIRED_CASES - 1 }));
    expect(small.join(' ')).toMatch(/Small sample: 29 paired cases/);
    expect(small.join(' ')).toMatch(/anecdote/);
    expect(warningsFor(interval({ n: MIN_PAIRED_CASES }))).toEqual([]);
  });

  it('says so when there is nothing to compare or resamples were dropped', () => {
    expect(warningsFor(interval({ n: 0 })).join(' ')).toMatch(/nothing to compare/);
    expect(warningsFor(interval({ undefinedResamples: 12 })).join(' ')).toMatch(/12 of 10000/);
  });
});

describe('caseValues and compareMetrics', () => {
  const fixtures = loadFixtures();
  const config: RunConfig = {
    provider: 'oracle',
    model: 'm',
    effort: null,
    promptVersion: 'triage-v1',
    reps: 1,
    seed: 0,
  };
  const refusedEverywhere: RunResult = {
    config,
    errors: [],
    results: fixtures.flatMap((f) =>
      f.cases.map((c) => ({
        repository: f.repository,
        caseId: c.id,
        rep: 0,
        cacheKey: 'k',
        cached: false,
        outcome: { status: 'refused', message: 'no' } as const,
      })),
    ),
  };

  it('scores an unanswered case as wrong: no labels found, priority missed', () => {
    const values = caseValues(refusedEverywhere, fixtures);
    for (const value of values.values()) {
      expect(value.exactSet).toBe(0);
      expect(value.priority).toBe(0);
      expect(value.labels.tp).toBe(0);
      expect(value.injection).toBeNull();
    }
  });

  it('pairs a run with itself to a zero delta on every metric', () => {
    const values = caseValues(refusedEverywhere, fixtures);
    for (const metric of compareMetrics(values, values)) {
      expect(metric.differing).toBe(0);
      if (metric.delta !== null) {
        expect(metric.delta).toBe(0);
      }
      expect(metric.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe('pairwisePreference', () => {
  const verdict = (winner: PairVerdict['winner'], flipped = false): PairVerdict => ({
    winner,
    flipped,
    orders: flipped ? ['left', 'right'] : [winner, winner],
    usage: [],
  });

  it('counts a flip as a tie: a judge that only follows position shows no preference', () => {
    const flips = Array.from({ length: 40 }, (_, i) => ({
      caseKey: `r/${i}`,
      verdict: verdict('tie', true),
    }));
    const preference = pairwisePreference(flips, { seed: 0, resamples: 1000, level: 0.95 });
    expect(preference.delta).toBe(0);
    expect(preference.reading).toBe('no difference shown');
  });

  it('is +1 when B wins every case in both orders', () => {
    const wins = Array.from({ length: 40 }, (_, i) => ({
      caseKey: `r/${i}`,
      verdict: verdict('right'),
    }));
    const preference = pairwisePreference(wins, { seed: 0, resamples: 1000, level: 0.95 });
    expect([preference.delta, preference.low, preference.high]).toEqual([1, 1, 1]);
    expect(preference.warnings).toEqual([]);
  });
});

describe('comparisonNotice', () => {
  const at = (provider: string): RunConfig => ({
    provider,
    model: 'm',
    effort: null,
    promptVersion: 'triage-v1',
    reps: 1,
    seed: 0,
  });

  it('labels any comparison with a local provider as illustrative', () => {
    expect(comparisonNotice(at('null'), at('fake'), 47)).toMatch(
      /^Illustrative only: "null" and "fake" are local providers/,
    );
    expect(comparisonNotice(at('fake'), at('anthropic'), 47)).toMatch(/^Illustrative only/);
    expect(comparisonNotice(at('anthropic'), at('anthropic'), 47)).not.toMatch(/Illustrative/);
    expect(comparisonNotice(at('anthropic'), at('anthropic'), 47)).toMatch(
      /not a significance test|no figure is a significance test/,
    );
  });
});

describe('npm run eval -- compare', () => {
  const readComparison = (out: string) => {
    const [name] = readdirSync(join(out, 'comparisons'));
    const dir = join(out, 'comparisons', name ?? '');
    return {
      dir,
      report: JSON.parse(readFileSync(join(dir, 'comparison.json'), 'utf8')) as ComparisonReport,
      markdown: readFileSync(join(dir, 'comparison.md'), 'utf8'),
    };
  };

  it('compares two local configs and writes markdown and JSON, labeled illustrative', async () => {
    const out = tempDir();
    const code = await main(['compare', '--a', 'null', '--b', 'fake', '--out', out], {
      env: {},
      now,
      log: noLog,
    });
    expect(code).toBe(0);
    const { dir, report, markdown } = readComparison(out);
    expect(dir).toContain('2026-11-22T12-00-00.000Z-null-vs-fake');
    expect(readdirSync(dir).sort()).toEqual([
      'comparison.json',
      'comparison.md',
      'errors.jsonl',
      'results-a.jsonl',
      'results-b.jsonl',
    ]);
    expect(report.notice).toMatch(/^Illustrative only/);
    expect(markdown).toContain(`> **${report.notice}**`);
    expect(report.metrics.map((m) => m.key)).toEqual([
      'labelF1',
      'exactSet',
      'priority',
      'duplicateRecall',
      'injectionResistance',
    ]);
    expect(report.pairwise).toBeUndefined();
    // Few cases have a true duplicate or a testable injection: those metrics must warn.
    for (const key of ['duplicateRecall', 'injectionResistance']) {
      const metric = report.metrics.find((m) => m.key === key);
      expect(metric?.n).toBeLessThan(MIN_PAIRED_CASES);
      expect(metric?.warnings.join(' ')).toMatch(/Small sample/);
      expect(metric?.reading).not.toMatch(/higher/);
    }
    expect(markdown).not.toMatch(/significant\b/i);
  });

  it('is deterministic for a bootstrap seed', async () => {
    const run = async (seed: string) => {
      const out = tempDir();
      const args = ['compare', '--a', 'null', '--b', 'fake', '--bootstrap-seed', seed];
      await main([...args, '--out', out], { env: {}, now, log: noLog });
      return readComparison(out).report.metrics.map((m) => [m.low, m.high]);
    };
    expect(await run('3')).toEqual(await run('3'));
    expect(await run('3')).not.toEqual(await run('4'));
  });

  it('with --judge fake: compares judge scores and runs the pairwise judge in both orders', async () => {
    const out = tempDir();
    const code = await main(
      ['compare', '--a', 'null', '--b', 'fake', '--judge', 'fake', '--out', out],
      {
        env: {},
        now,
        log: noLog,
      },
    );
    expect(code).toBe(0);
    const { dir, report, markdown } = readComparison(out);
    expect(report.metrics.map((m) => m.key)).toEqual(
      expect.arrayContaining(['judge.faithfulness', 'judge.coverage', 'judge.concision']),
    );
    expect(report.pairwise?.judge).toEqual({ model: 'fake-judge', promptVersion: 'pairwise-v1' });
    const tally = report.pairwise?.tally;
    expect(tally && tally.left + tally.right + tally.ties).toBe(tally?.pairs);
    expect(markdown).toContain('## Pairwise judge');
    expect(markdown).toContain('Flips');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['pairwise.jsonl']));
  });

  it('refuses a real provider on either side, and a real judge, under tests, CI, and agent sessions', async () => {
    const everything = {
      EVAL_REAL_CALLS: '1',
      EVAL_ALLOW_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-ant-placeholder',
      AWS_REGION: 'us-east-1',
    };
    const commands = [
      ['--a', 'anthropic', '--b', 'fake'],
      ['--a', 'fake', '--b', 'anthropic'],
      ['--a', 'fake', '--b', 'bedrock'],
      ['--a', 'fake', '--b', 'null', '--judge', 'anthropic'],
    ];
    const environments: Record<string, string | undefined>[] = [
      { ...everything, VITEST: 'true' },
      { ...everything, CI: 'true' },
      { ...everything, CLAUDECODE: '1' },
      {},
    ];
    for (const env of environments) {
      for (const args of commands) {
        const createModel = vi.fn();
        const createJudgeMessage = vi.fn<CreateMessage>();
        const log = vi.fn();
        const out = tempDir();
        const code = await main(['compare', ...args, '--out', out], {
          env,
          createModel,
          createJudgeMessage,
          log,
        });
        expect(code).toBe(2);
        expect(createModel).not.toHaveBeenCalled();
        expect(createJudgeMessage).not.toHaveBeenCalled();
        expect(readdirSync(out)).toEqual([]);
        if (env.CLAUDECODE) {
          expect(log.mock.calls.flat().join('\n')).toContain('CLAUDECODE');
        }
      }
    }
  });

  it('needs both sides', async () => {
    const log = vi.fn();
    expect(await main(['compare', '--a', 'fake', '--out', tempDir()], { env: {}, log })).toBe(2);
    expect(log.mock.calls.flat().join('\n')).toContain('--b <provider> is required');
  });
});
