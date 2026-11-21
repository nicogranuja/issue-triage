import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_FILE,
  calibrationItems,
  calibrationResult,
  loadCalibration,
} from '../../evals/calibration.js';
import { loadFixtures } from '../../evals/cases.js';
import { FakeSummaryJudge, JUDGE_PROMPT_VERSION } from '../../evals/judge.js';
import { judgeConfigOf, judgeItems } from '../../evals/judging.js';

const fixtures = loadFixtures();
const set = loadCalibration(fixtures);

describe('the calibration set', () => {
  it('validates, has 15 to 20 items, and is written against the current judge prompt', () => {
    expect(set.items.length).toBeGreaterThanOrEqual(15);
    expect(set.items.length).toBeLessThanOrEqual(20);
    expect(set.rubric).toBe(JUDGE_PROMPT_VERSION);
  });

  it('includes every known negative, and the verbosity check', () => {
    const kinds = new Set(set.items.map((item) => item.kind));
    for (const kind of ['empty', 'dont-know', 'wrong-issue', 'unfaithful', 'verbose']) {
      expect(kinds, kind).toContain(kind);
    }
    const empty = set.items.find((item) => item.kind === 'empty');
    expect(empty?.summary).toBe('');
    // The verbose item is correct: faithful and complete, and only concision is marked down.
    const verbose = set.items.find((item) => item.kind === 'verbose');
    expect(verbose?.hand.faithfulness.score).toBe(5);
    expect(verbose?.hand.coverage.score).toBe(5);
    expect(verbose?.hand.concision.score).toBeLessThanOrEqual(2);
  });

  it('spreads its hand scores over the scale on every criterion', () => {
    for (const criterion of ['faithfulness', 'coverage', 'concision'] as const) {
      const scores = new Set(set.items.map((item) => item.hand[criterion].score));
      expect(scores.size, criterion).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects an item that names a missing case, a duplicate id, or a score out of range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-triage-calibration-'));
    try {
      const write = (items: unknown[]) => {
        const path = join(dir, 'set.json');
        writeFileSync(path, JSON.stringify({ ...set, items }));
        return path;
      };
      const [item] = set.items;
      expect(() => loadCalibration(fixtures, write([{ ...item, caseId: 'atlas-99' }]))).toThrow(
        /no case/,
      );
      expect(() => loadCalibration(fixtures, write([item, item]))).toThrow(/unique/);
      const outOfRange = {
        ...item,
        hand: { ...item?.hand, coverage: { score: 6, note: 'Too high, on purpose.' } },
      };
      expect(() => loadCalibration(fixtures, write([outOfRange]))).toThrow(/Invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never shows the judge the hand scores, notes, kind, or id', async () => {
    const judge = new FakeSummaryJudge();
    const items = calibrationItems(set, fixtures);
    await judgeItems({ items, judge, config: judgeConfigOf('fake', judge) });
    expect(judge.inputs).toHaveLength(set.items.length);
    const shown = JSON.stringify(judge.inputs);
    for (const item of set.items) {
      for (const { note } of Object.values(item.hand)) {
        expect(shown).not.toContain(note);
      }
      expect(shown).not.toContain(item.id);
    }
    expect(shown).not.toMatch(/"hand"|"kind"|"score"/);
    expect(CALIBRATION_FILE).toMatch(/summaries-v1\.json$/);
  });

  it('pairs judge and hand scores per item for the agreement figures', async () => {
    const judge = new FakeSummaryJudge();
    const run = await judgeItems({
      items: calibrationItems(set, fixtures),
      judge,
      config: judgeConfigOf('fake', judge),
    });
    const result = calibrationResult(set, run);
    expect(result.judged).toBe(set.items.length);
    expect(result.agreement.faithfulness.n).toBe(set.items.length);
    // The fake judge scores the empty summary 1 on everything, like the hand scores.
    const empty = result.pairs.find((pair) => pair.kind === 'empty');
    expect(empty?.judge).toEqual(empty?.hand);
    // A failed item drops out of the figures instead of counting as a score.
    const partial = calibrationResult(set, { ...run, results: run.results.slice(1) });
    expect(partial.judged).toBe(set.items.length - 1);
    expect(partial.pairs[0]?.judge).toBeNull();
    expect(partial.agreement.coverage.n).toBe(set.items.length - 1);
  });
});
