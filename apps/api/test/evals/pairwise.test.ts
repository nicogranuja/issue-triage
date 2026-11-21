import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { JUDGE_MODEL, JudgeError } from '../../evals/judge.js';
import {
  comparePair,
  FakePairwiseJudge,
  MessagesPairwiseJudge,
  pairwisePrompt,
  tallyPairs,
  type PairwiseJudge,
  type Preference,
} from '../../evals/pairwise.js';
import type { CreateMessage } from '../../src/triage/messages-model.js';
import { NO_JUDGE_USAGE } from '../../evals/judge.js';

const signal = new AbortController().signal;
const pair = {
  issue: { title: 'Export to PDF crashes', body: 'Exporting a 200-page note crashes the app.' },
  keyPoints: ['PDF export crashes', 'Large notes (200 pages)'],
  left: 'Exporting a 200-page note to PDF crashes the app.',
  right: 'Something unrelated.',
};

/** A judge that answers from a script, one answer per call. */
function scripted(answers: Preference[]): PairwiseJudge {
  let call = 0;
  return {
    modelId: 'scripted',
    promptVersion: 'pairwise-v1',
    prefer: () =>
      Promise.resolve({
        preferred: answers[call++] ?? 'tie',
        rationale: 'r',
        usage: NO_JUDGE_USAGE,
      }),
  };
}

describe('comparePair', () => {
  it('asks in both orders, swapping the positions', async () => {
    const judge = new FakePairwiseJudge();
    await comparePair(judge, pair, { signal });
    expect(judge.inputs.map((i) => [i.a, i.b])).toEqual([
      [pair.left, pair.right],
      [pair.right, pair.left],
    ]);
  });

  it.each([
    // [first order (left is A), second order (right is A)] -> winner, flipped
    [['A', 'B'], 'left', false], // left both times
    [['B', 'A'], 'right', false], // right both times
    [['A', 'A'], 'tie', true], // position A both times: a flip
    [['B', 'B'], 'tie', true], // position B both times: a flip
    [['tie', 'tie'], 'tie', false],
    [['A', 'tie'], 'tie', false], // a win in one order only is not a win
  ] as const)('maps %j to %s (flip: %s)', async (answers, winner, flipped) => {
    const verdict = await comparePair(scripted([...answers]), pair, { signal });
    expect(verdict.winner).toBe(winner);
    expect(verdict.flipped).toBe(flipped);
  });

  it('counts a judge with pure position bias as all flips and ties', async () => {
    const judge = new FakePairwiseJudge({ alwaysFirst: true });
    const verdicts = [
      await comparePair(judge, pair, { signal }),
      await comparePair(judge, { ...pair, left: pair.right, right: pair.left }, { signal }),
    ];
    expect(tallyPairs(verdicts)).toEqual({
      pairs: 2,
      left: 0,
      right: 0,
      ties: 2,
      flips: 2,
      flipRate: 1,
    });
  });

  it('lets the content win in both orders with an unbiased judge', async () => {
    const verdict = await comparePair(new FakePairwiseJudge(), pair, { signal });
    expect(verdict).toMatchObject({ winner: 'left', flipped: false, orders: ['left', 'left'] });
    expect(tallyPairs([])).toMatchObject({ pairs: 0, flipRate: null });
  });
});

describe('MessagesPairwiseJudge', () => {
  const reply = (text: string, model = JUDGE_MODEL) =>
    ({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, iterations: null },
    }) as unknown as Anthropic.Beta.BetaMessage;

  it('asks the fixed judge model and checks the answer', async () => {
    const createMessage = vi.fn<CreateMessage>(() =>
      Promise.resolve(reply('{"rationale":"A covers both points.","preferred":"A"}')),
    );
    const judge = new MessagesPairwiseJudge({ createMessage });
    const input = { issue: pair.issue, keyPoints: pair.keyPoints, a: pair.left, b: pair.right };
    expect((await judge.prefer(input, { signal })).preferred).toBe('A');
    const params = createMessage.mock.calls[0]?.[0];
    expect(params?.model).toBe(JUDGE_MODEL);
    expect(params).not.toHaveProperty('fallbacks');

    const otherModel = new MessagesPairwiseJudge({
      createMessage: () => Promise.resolve(reply('{"rationale":"r","preferred":"A"}', 'x')),
    });
    await expect(otherModel.prefer(input, { signal })).rejects.toThrow(JudgeError);
    const offSchema = new MessagesPairwiseJudge({
      createMessage: () => Promise.resolve(reply('{"rationale":"r","preferred":"first"}')),
    });
    await expect(offSchema.prefer(input, { signal })).rejects.toThrow(/schema/);
  });

  it('shows two unlabeled summaries and says neither length nor order is quality', () => {
    const { system, user } = pairwisePrompt({
      issue: pair.issue,
      keyPoints: pair.keyPoints,
      a: pair.left,
      b: pair.right,
    });
    expect(system).toContain('Length is not quality.');
    expect(system).toContain('The order in which the summaries appear says nothing about them.');
    expect(user).toContain('<summary_a>');
    expect(`${system}\n${user}`).not.toMatch(/claude-|fake-triage-model|prompt version|reference/i);
  });
});
