import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nullModel, oracleModel } from '../../evals/baselines.js';
import { loadFixtures, triageInputFor } from '../../evals/cases.js';
import { main } from '../../evals/cli.js';
import { blockedEnvironment, checkRealCalls } from '../../evals/guard.js';
import { summarize, type Report } from '../../evals/report.js';
import { cacheKey, runEval, type RunConfig } from '../../evals/runner.js';
import { FakeTriageModel, keywordSuggestion } from '../../src/triage/fake-model.js';
import { ModelRefusalError, TriageModelError, type TriageInput } from '../../src/triage/model.js';

const fixtures = loadFixtures();
const totalCases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
const [first] = fixtures;
const [caseA, caseB] = first?.cases ?? [];
if (!first || !caseA || !caseB) {
  throw new Error('The eval fixtures are missing');
}
/** One repository's cases: enough for tests that don't need all of them. */
const subset = [first];
const noLog = () => undefined;

const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  provider: 'fake',
  model: 'fake-triage-model',
  effort: null,
  promptVersion: 'triage-v1',
  reps: 1,
  seed: 0,
  ...overrides,
});

const directories: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-triage-eval-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runEval over the fixtures', () => {
  it('scores the oracle perfectly', async () => {
    const run = await runEval({ fixtures, model: oracleModel(fixtures), config: config() });
    const summary = summarize('oracle', run, fixtures);

    expect(summary).toMatchObject({ scored: totalCases, answered: totalCases, infraErrors: 0 });
    expect(summary.labels.micro.f1).toBe(1);
    expect(summary.labels.exactSetMatch).toBe(1);
    expect(summary.priority.accuracy).toBe(1);
    expect(summary.strict).toEqual({ exactSetMatch: 1, priorityAccuracy: 1 });
    // The oracle names only offered duplicates: perfect precision, recall capped by the
    // pre-filter, which misses the paraphrased duplicate in the fixtures.
    expect(summary.duplicates.micro.precision).toBe(1);
    expect(summary.duplicates.micro.recall).toBe(summary.duplicates.preFilterRecall);
    expect(summary.duplicates.preFilterRecall).toBeLessThan(1);
  });

  it('gives the null model no label recall', async () => {
    const run = await runEval({ fixtures, model: nullModel(), config: config() });
    const summary = summarize('null', run, fixtures);

    expect(summary.answered).toBe(totalCases);
    expect(summary.labels.micro.recall).toBe(0);
    expect(summary.labels.micro.precision).toBeNull();
    expect(summary.priority.confusion.low.low).toBe((summary.priority.accuracy ?? 0) * totalCases);
  });

  it('runs the keyword baseline on every case, and its answers pass the re-check', async () => {
    const model = new FakeTriageModel();
    const run = await runEval({ fixtures, model, config: config({ reps: 2 }) });

    expect(model.inputs).toHaveLength(totalCases * 2);
    expect(run.errors).toEqual([]);
    expect(run.results.every((result) => result.outcome.status === 'answered')).toBe(true);
    // The model gets exactly what the worker would send.
    expect(model.inputs[0]).toEqual(triageInputFor(first, caseA));
  });

  it("re-checks answers: a label outside the repository's set is invalid output", async () => {
    const model = new FakeTriageModel({
      respond: (input) => {
        const suggestion = keywordSuggestion(input);
        return { ...suggestion, labels: { ...suggestion.labels, names: ['not-a-label'] } };
      },
    });
    const run = await runEval({ fixtures: subset, model, config: config() });
    const summary = summarize('bad', run, fixtures);

    expect(run.results[0]?.outcome).toMatchObject({ status: 'invalid', stage: 'recheck' });
    expect(summary).toMatchObject({ answered: 0, invalid: run.results.length });
    // Invalid output is a scored failure: the strict figures count it as wrong.
    expect(summary.strict).toEqual({ exactSetMatch: 0, priorityAccuracy: 0 });
  });
});

describe('the cache', () => {
  it('answers a repeated run without calling the model', async () => {
    const cacheDir = tempDir();
    const first = new FakeTriageModel();
    const before = await runEval({ fixtures, model: first, config: config(), cacheDir });
    expect(before.results.some((result) => result.cached)).toBe(false);

    const second = new FakeTriageModel();
    const after = await runEval({ fixtures, model: second, config: config(), cacheDir });

    expect(second.inputs).toEqual([]);
    expect(after.results.every((result) => result.cached)).toBe(true);
    expect(after.results.map((result) => result.outcome)).toEqual(
      before.results.map((result) => result.outcome),
    );
  });

  it.each([
    ['provider', { provider: 'anthropic' }],
    ['model', { model: 'another-model' }],
    ['effort', { effort: 'high' }],
    ['prompt version', { promptVersion: 'triage-v2' }],
    ['seed', { seed: 1 }],
  ] satisfies [string, Partial<RunConfig>][])('misses when the %s changes', async (_, change) => {
    const cacheDir = tempDir();
    await runEval({ fixtures: subset, model: new FakeTriageModel(), config: config(), cacheDir });

    const model = new FakeTriageModel();
    const run = await runEval({ fixtures: subset, model, config: config(change), cacheDir });

    expect(run.results.some((result) => result.cached)).toBe(false);
    expect(model.inputs).toHaveLength(first.cases.length);
  });

  it('keys each rep, the case, and the rendered prompt separately', () => {
    const input = triageInputFor(first, caseA);
    const key = cacheKey(first, caseA, input, config(), 0);

    expect(cacheKey(first, caseA, input, config(), 1)).not.toBe(key);
    expect(cacheKey(first, caseB, triageInputFor(first, caseB), config(), 0)).not.toBe(key);
    // Same case, different candidates (say, a changed pre-filter): a different rendered prompt.
    const fewer: TriageInput = { ...input, candidates: input.candidates.slice(1) };
    expect(cacheKey(first, caseA, fewer, config(), 0)).not.toBe(key);
  });
});

describe('infrastructure errors', () => {
  it('go to the sidecar, not the scores or the cache; refusals are scored', async () => {
    const cacheDir = tempDir();
    const [timedOut, refused] = [caseA, caseB];
    const respond = (input: TriageInput) => {
      if (input.issue.number === timedOut.issue.number) {
        throw new TriageModelError('Model request failed: timed out (secret request body)', {
          retryable: true,
          logMessage: 'Model request failed',
        });
      }
      if (input.issue.number === refused.issue.number) {
        throw new ModelRefusalError('cyber');
      }
      return keywordSuggestion(input);
    };
    const run = await runEval({
      fixtures: subset,
      model: new FakeTriageModel({ respond }),
      config: config(),
      cacheDir,
    });
    const summary = summarize('flaky', run, fixtures);

    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toMatchObject({
      repository: first.repository,
      caseId: timedOut.id,
      rep: 0,
      error: { type: 'TriageModelError', retryable: true, message: 'Model request failed' },
    });
    // The sidecar keeps the safe log message, not one that may quote the provider.
    expect(JSON.stringify(run.errors)).not.toContain('secret');
    expect(run.results.map((result) => result.caseId)).not.toContain(timedOut.id);
    expect(summary).toMatchObject({
      scored: first.cases.length - 1,
      refused: 1,
      infraErrors: 1,
    });

    // The next run retries the failed case (it wasn't cached) and nothing else.
    const retry = new FakeTriageModel();
    await runEval({ fixtures: subset, model: retry, config: config(), cacheDir });
    expect(retry.inputs.map((input) => input.issue.number)).toEqual([timedOut.issue.number]);
  });
});

describe('the real-call guard', () => {
  const both = { EVAL_REAL_CALLS: '1', ANTHROPIC_API_KEY: 'sk-ant-placeholder' };

  it.each([
    ['no opt-in and no key', {}],
    ['only the key', { ANTHROPIC_API_KEY: 'sk-ant-placeholder' }],
    ['only the opt-in', { EVAL_REAL_CALLS: '1' }],
    [
      'an opt-in other than 1',
      { EVAL_REAL_CALLS: 'true', ANTHROPIC_API_KEY: 'sk-ant-placeholder' },
    ],
    ['both, under Vitest', { ...both, VITEST: 'true' }],
    ['both, in CI', { ...both, CI: 'true' }],
  ])('refuses anthropic with %s', (_, env) => {
    expect(checkRealCalls('anthropic', env)).toMatchObject({ allowed: false });
  });

  it('allows anthropic with both, outside tests and CI', () => {
    expect(checkRealCalls('anthropic', both)).toEqual({ allowed: true });
  });

  it('refuses bedrock without the opt-in, whatever AWS credentials the shell has', () => {
    const aws = {
      AWS_ACCESS_KEY_ID: 'placeholder',
      AWS_PROFILE: 'default',
      AWS_REGION: 'us-east-1',
    };
    expect(checkRealCalls('bedrock', aws)).toMatchObject({ allowed: false });
    expect(checkRealCalls('bedrock', { ...aws, EVAL_REAL_CALLS: '1', CI: 'true' })).toMatchObject({
      allowed: false,
    });
  });

  it('refuses bedrock without its own opt-in, even with EVAL_REAL_CALLS=1', () => {
    const aws = { AWS_BEARER_TOKEN_BEDROCK: 'placeholder', AWS_REGION: 'us-east-1' };
    const refused = checkRealCalls('bedrock', { ...aws, EVAL_REAL_CALLS: '1' });
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? '' : refused.reason).toContain('EVAL_ALLOW_BEDROCK=1');
    expect(
      checkRealCalls('bedrock', { ...aws, EVAL_REAL_CALLS: '1', EVAL_ALLOW_BEDROCK: '1' }),
    ).toEqual({ allowed: true });
  });

  it('refuses every real provider from an AI coding agent session, whatever the opt-ins', () => {
    const everything = {
      EVAL_REAL_CALLS: '1',
      EVAL_ALLOW_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-ant-placeholder',
      AWS_BEARER_TOKEN_BEDROCK: 'placeholder',
      CLAUDECODE: '1',
    };
    for (const provider of ['anthropic', 'bedrock'] as const) {
      const refused = checkRealCalls(provider, everything);
      expect(refused.allowed).toBe(false);
      expect(refused.allowed ? '' : refused.reason).toContain('CLAUDECODE');
    }
    expect(blockedEnvironment({ CLAUDECODE: '1' })).toContain('agent');
    expect(blockedEnvironment({})).toBeNull();
  });

  it('lets the local providers run with nothing set', () => {
    for (const provider of ['fake', 'oracle', 'null'] as const) {
      expect(checkRealCalls(provider, {})).toEqual({ allowed: true });
    }
  });

  it('stops the CLI before any model is built', async () => {
    const createModel = vi.fn();
    const log = vi.fn();
    for (const provider of ['anthropic', 'bedrock']) {
      const code = await main(['--provider', provider, '--out', tempDir()], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-placeholder', AWS_REGION: 'us-east-1' },
        createModel,
        log,
      });
      expect(code).toBe(2);
    }
    expect(createModel).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('EVAL_REAL_CALLS=1');
  });
});

describe('the CLI', () => {
  it('writes a report labeled illustrative, an empty sidecar, and per-case results', async () => {
    const out = tempDir();
    const code = await main(['--provider', 'fake', '--out', out], {
      env: {},
      now: () => new Date('2026-11-19T12:00:00Z'),
      log: noLog,
    });
    expect(code).toBe(0);

    const runDir = join(out, 'runs', '2026-11-19T12-00-00.000Z-fake');
    expect(readdirSync(runDir).sort()).toEqual([
      'errors.jsonl',
      'report.json',
      'report.md',
      'results.jsonl',
    ]);
    expect(readFileSync(join(runDir, 'report.md'), 'utf8')).toContain('Illustrative only');
    expect(readFileSync(join(runDir, 'errors.jsonl'), 'utf8')).toBe('');
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as Report;
    expect(report.baselines.map((baseline) => baseline.name)).toEqual(['oracle', 'null']);
    // Local providers always run fresh: no cache directory.
    expect(readdirSync(out)).toEqual(['runs']);
  });
});
