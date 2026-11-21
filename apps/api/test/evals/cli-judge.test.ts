import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../evals/cli.js';
import { JUDGE_MODEL } from '../../evals/judge.js';
import type { Report } from '../../evals/report.js';
import type { CreateMessage } from '../../src/triage/messages-model.js';

const directories: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-triage-cli-judge-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const noLog = () => undefined;
const now = () => new Date('2026-11-21T12:00:00Z');
const runDir = (out: string) => join(out, 'runs', '2026-11-21T12-00-00.000Z-fake');
const readReport = (out: string) =>
  JSON.parse(readFileSync(join(runDir(out), 'report.json'), 'utf8')) as Report;

/** A stand-in for the SDK call: a fixed verdict from the judge model, with usage. */
const judgeReply = vi.fn<CreateMessage>(() =>
  Promise.resolve({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: JUDGE_MODEL,
    content: [
      {
        type: 'text',
        citations: null,
        text: JSON.stringify({
          faithfulness: { rationale: 'r', score: 4 },
          coverage: { rationale: 'r', score: 3 },
          concision: { rationale: 'r', score: 5 },
        }),
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
  } as unknown as Anthropic.Beta.BetaMessage),
);

describe('--judge', () => {
  it('is off by default: no judge section, no judge files', async () => {
    const out = tempDir();
    expect(await main(['--out', out], { env: {}, now, log: noLog })).toBe(0);
    expect(readReport(out).judge).toBeUndefined();
    expect(readdirSync(runDir(out))).not.toContain('judgments.jsonl');
  });

  it('fake: adds judge scores, agreement, and judge cost, and says the agreement is meaningless', async () => {
    const out = tempDir();
    expect(await main(['--judge', 'fake', '--out', out], { env: {}, now, log: noLog })).toBe(0);
    const report = readReport(out);
    expect(report.judge?.run.config).toEqual({
      kind: 'fake',
      model: 'fake-judge',
      effort: null,
      promptVersion: 'judge-v1',
    });
    expect(report.judge?.run.judged).toBe(report.run.answered);
    expect(report.judge?.calibration.result.judged).toBe(report.judge?.calibration.result.items);
    expect(report.judge?.notice).toMatch(/meaningless/);
    expect(report.judge?.notice).toMatch(/your own terminal/);
    const markdown = readFileSync(join(runDir(out), 'report.md'), 'utf8');
    for (const heading of [
      '## Summary judge',
      '### Judge-hand agreement',
      '### Judge tokens and cost',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(readdirSync(runDir(out))).toEqual(
      expect.arrayContaining(['judgments.jsonl', 'calibration.jsonl', 'judge-errors.jsonl']),
    );
    // The fake judge is local: no verdict cache.
    expect(readdirSync(out)).toEqual(['runs']);
  });

  it('refuses a real judge under tests, CI, and agent sessions, before anything runs', async () => {
    const everything = { EVAL_REAL_CALLS: '1', ANTHROPIC_API_KEY: 'sk-ant-placeholder' };
    for (const env of [
      { ...everything, VITEST: 'true' },
      { ...everything, CI: 'true' },
      { ...everything, CLAUDECODE: '1' },
      {},
    ]) {
      const createModel = vi.fn();
      const createJudgeMessage = vi.fn<CreateMessage>();
      const out = tempDir();
      const log = vi.fn();
      const code = await main(['--judge', 'anthropic', '--out', out], {
        env,
        createModel,
        createJudgeMessage,
        log,
      });
      expect(code).toBe(2);
      expect(createJudgeMessage).not.toHaveBeenCalled();
      expect(readdirSync(out)).toEqual([]);
      expect(log.mock.calls.flat().join('\n')).toMatch(/judge/);
    }
  });

  it('rejects an unknown judge', async () => {
    const log = vi.fn();
    expect(await main(['--judge', 'gpt', '--out', tempDir()], { env: {}, log })).toBe(2);
    expect(log.mock.calls.flat().join('\n')).toContain('--judge must be one of fake, anthropic');
  });

  it('anthropic, with the opt-ins and a stubbed SDK call: reports cost, caches verdicts', async () => {
    const out = tempDir();
    const env = { EVAL_REAL_CALLS: '1', ANTHROPIC_API_KEY: 'sk-ant-placeholder' };
    const deps = { env, createJudgeMessage: judgeReply, now, log: noLog };
    expect(await main(['--judge', 'anthropic', '--out', out], deps)).toBe(0);
    const calls = judgeReply.mock.calls.length;
    const report = readReport(out);
    const judged = (report.judge?.run.judged ?? 0) + (report.judge?.calibration.result.judged ?? 0);
    // Identical summaries share a verdict (the cache is content-addressed), so calls <= judged.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(judged);
    expect(judgeReply.mock.calls[0]?.[0].model).toBe(JUDGE_MODEL);
    expect(report.judge?.run.config).toMatchObject({ kind: 'anthropic', effort: 'high' });
    expect(report.judge?.run.scores.coverage.mean).toBe(3);
    // $2 per MTok in, $10 out, per judged summary.
    expect(report.judge?.run.cost.totalUsd).toBeGreaterThan(0);
    expect(report.judge?.notice).toMatch(/not yet re-scored by a person/);
    expect(readdirSync(out).sort()).toEqual(['judge-cache', 'runs']);

    // A second run answers from the verdict cache.
    rmSync(join(out, 'runs'), { recursive: true });
    expect(await main(['--judge', 'anthropic', '--out', out], deps)).toBe(0);
    expect(judgeReply.mock.calls.length).toBe(calls);
    expect(readReport(out).judge?.run.cached).toBe(readReport(out).judge?.run.judged);
  });
});
