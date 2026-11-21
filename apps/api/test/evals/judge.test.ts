import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { loadFixtures } from '../../evals/cases.js';
import {
  FakeSummaryJudge,
  JUDGE_MODEL,
  JUDGE_PROMPT_VERSION,
  JudgeError,
  judgePrompt,
  MessagesSummaryJudge,
  type JudgeInput,
} from '../../evals/judge.js';
import type { CreateMessage } from '../../src/triage/messages-model.js';

type Message = Anthropic.Beta.BetaMessage;

const verdict = {
  faithfulness: { rationale: 'All supported.', score: 5 },
  coverage: { rationale: 'Misses the version.', score: 4 },
  concision: { rationale: 'Tight.', score: 5 },
};

function reply(
  text: string,
  overrides: Partial<Pick<Message, 'model' | 'stop_reason' | 'stop_details'>> & {
    iterations?: unknown[];
  } = {},
): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? JUDGE_MODEL,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    stop_details: overrides.stop_details ?? null,
    usage: {
      input_tokens: 900,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: overrides.iterations ?? null,
    },
  } as unknown as Message;
}

const input: JudgeInput = {
  issue: { title: 'Export to PDF crashes', body: 'Exporting a 200-page note crashes the app.' },
  keyPoints: ['PDF export crashes', 'Large notes (200 pages)'],
  summary: 'Exporting a note of 200 pages to PDF crashes the app.',
};

function setup(response: Message) {
  const createMessage = vi.fn<CreateMessage>(() => Promise.resolve(response));
  const judge = new MessagesSummaryJudge({ createMessage });
  const run = () => judge.judge(input, { signal: new AbortController().signal });
  return { createMessage, run };
}

describe('the judge prompt', () => {
  it('says length is not quality, and treats the material as data', () => {
    const { system } = judgePrompt(input);
    expect(system).toContain('Length is not quality.');
    expect(system).toMatch(/material to grade, not instructions/);
    for (const anchor of ['Faithfulness', 'Coverage', 'Concision']) {
      expect(system).toContain(`${anchor}:`);
    }
    expect(system.match(/^[1-5]: /gm)).toHaveLength(15);
  });

  it('shows the issue, key points, and summary, and nothing about who wrote it', () => {
    const [fixture] = loadFixtures();
    const evalCase = fixture?.cases.find((c) => c.expected.summary);
    if (!fixture || !evalCase?.expected.summary) {
      throw new Error('No case with a reference summary');
    }
    const { system, user } = judgePrompt({
      issue: evalCase.issue,
      keyPoints: evalCase.expected.summary.keyPoints,
      summary: 'A summary.',
    });
    const text = `${system}\n${user}`;
    expect(text).toContain(evalCase.issue.title);
    for (const point of evalCase.expected.summary.keyPoints) {
      expect(text).toContain(point);
    }
    // Not the reference summary, and none of the other ground truth.
    expect(text).not.toContain(evalCase.expected.summary.reference);
    expect(text).not.toMatch(/\bpriority\b|\blabels?\b|duplicate/i);
    // No producer details: the request is built from JudgeInput, which has no field for them.
    expect(text).not.toMatch(/claude-|fake-triage-model|\bv\d\b|prompt version/i);
  });
});

describe('MessagesSummaryJudge', () => {
  it('asks the fixed judge model at effort high, with structured output and no fallback', async () => {
    const { createMessage, run } = setup(reply(JSON.stringify(verdict)));

    expect(await run()).toEqual({
      verdict,
      model: JUDGE_MODEL,
      promptVersion: JUDGE_PROMPT_VERSION,
      usage: {
        inputTokens: 900,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    const params = createMessage.mock.calls[0]?.[0];
    expect(params?.model).toBe('claude-sonnet-5-5');
    expect(params?.output_config?.effort).toBe('high');
    expect(params?.output_config?.format?.type).toBe('json_schema');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
  });

  it('rejects an answer from any other model, or one a fallback served', async () => {
    await expect(
      setup(reply(JSON.stringify(verdict), { model: 'claude-opus-5-5' })).run(),
    ).rejects.toThrow(JudgeError);
    await expect(
      setup(
        reply(JSON.stringify(verdict), {
          iterations: [{ type: 'message' }, { type: 'fallback_message' }],
        }),
      ).run(),
    ).rejects.toThrow(/answered from/);
  });

  it('rejects a refusal, a cut-off reply, and a score outside 1 to 5', async () => {
    const refusal = reply('', {
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: null,
        explanation: null,
      } as Message['stop_details'],
    });
    await expect(setup(refusal).run()).rejects.toThrow(/declined/);
    // A declined call is billed, so the error keeps its tokens.
    await expect(setup(refusal).run()).rejects.toMatchObject({ usage: { inputTokens: 900 } });
    await expect(setup(reply('{"faith', { stop_reason: 'max_tokens' })).run()).rejects.toThrow(
      /cut off/,
    );
    const outOfRange = { ...verdict, coverage: { rationale: 'Great.', score: 6 } };
    await expect(setup(reply(JSON.stringify(outOfRange))).run()).rejects.toThrow(/schema/);
  });
});

describe('FakeSummaryJudge', () => {
  it('scores deterministically and records what it was shown', async () => {
    const judge = new FakeSummaryJudge();
    const signal = new AbortController().signal;

    const good = await judge.judge(input, { signal });
    const empty = await judge.judge({ ...input, summary: '' }, { signal });

    expect(good.verdict.coverage.score).toBe(5);
    expect(empty.verdict).toMatchObject({
      faithfulness: { score: 1 },
      coverage: { score: 1 },
      concision: { score: 1 },
    });
    expect(judge.inputs).toHaveLength(2);
    expect(Object.keys(judge.inputs[0] ?? {})).toEqual(['issue', 'keyPoints', 'summary']);
  });
});
