import { describe, expect, it } from 'vitest';

import { nullModel, oracleModel } from '../../evals/baselines.js';
import { loadFixtures } from '../../evals/cases.js';
import { buildReport, renderMarkdown, summarize } from '../../evals/report.js';
import { runEval, type RunConfig } from '../../evals/runner.js';
import { FakeTriageModel, keywordSuggestion } from '../../src/triage/fake-model.js';
import { ModelRefusalError, type TriageModel } from '../../src/triage/model.js';

const fixtures = loadFixtures();
const injected = fixtures.flatMap((fixture) =>
  fixture.cases.filter((evalCase) => evalCase.injection).map((evalCase) => ({ fixture, evalCase })),
);

const config = (provider: string): RunConfig => ({
  provider,
  model: `${provider}-model`,
  effort: null,
  promptVersion: 'v1',
  reps: 1,
  seed: 0,
});

async function summary(name: string, model: TriageModel, provider = name) {
  return summarize(name, await runEval({ fixtures, model, config: config(provider) }), fixtures);
}

describe('injection resistance in the report', () => {
  it('the oracle obeys nothing, over every injection case', async () => {
    const { injection } = await summary('oracle', oracleModel(fixtures));
    expect(injected.length).toBeGreaterThan(0);
    expect(injection).toMatchObject({ cases: injected.length, obeyed: 0, unanswered: 0 });
  });

  it('counts a model that writes the demanded summary as obeying', async () => {
    const demanded = injected.find(({ evalCase }) => evalCase.injection?.summary);
    if (!demanded) {
      throw new Error('The fixtures have no demanded summary');
    }
    const obeying = new FakeTriageModel({
      respond: (input) => ({
        ...keywordSuggestion(input),
        summary:
          input.issue.number === demanded.evalCase.issue.number
            ? (demanded.evalCase.injection?.summary ?? '')
            : input.issue.title,
      }),
    });
    const { injection } = await summary('obeying', obeying, 'fake');
    expect(injection.byField.summary).toBe(1);
    expect(injection.obeyed).toBeGreaterThanOrEqual(1);
  });

  it('shows the section in the markdown', async () => {
    const run = await summary('null', nullModel());
    const markdown = renderMarkdown(buildReport(run, [], fixtures, new Date(0)));
    expect(markdown).toContain('## Injection resistance');
  });
});

describe('validity in the report', () => {
  it('counts a corrected answer as valid but not first-try valid', async () => {
    const [first] = fixtures.flatMap((fixture) => fixture.cases);
    const base = new FakeTriageModel();
    const corrected: TriageModel = {
      provider: base.provider,
      modelId: base.modelId,
      effort: base.effort,
      promptVersion: base.promptVersion,
      suggest: async (input, options) => {
        const result = await base.suggest(input, options);
        return input.issue.number === first?.issue.number ? { ...result, modelCalls: 2 } : result;
      },
    };
    const { validity, scored } = await summary('corrected', corrected, 'fake');
    expect(validity).toEqual({
      cases: scored,
      schemaValid: 1,
      firstTryValid: (scored - 1) / scored,
    });
  });
});

/** The keyword baseline, with some cases' results replaced. */
function scripted(
  change: (number: number, result: Awaited<ReturnType<TriageModel['suggest']>>) => typeof result,
): TriageModel {
  const base = new FakeTriageModel();
  return {
    provider: base.provider,
    modelId: base.modelId,
    effort: base.effort,
    promptVersion: base.promptVersion,
    suggest: async (input, options) =>
      change(input.issue.number, await base.suggest(input, options)),
  };
}

describe('refusals and fallbacks in the report', () => {
  it('reads the fallback flag the provider reported, and counts refusals', async () => {
    const [first, second] = fixtures[0]?.cases ?? [];
    const model = scripted((number, result) => {
      if (number === first?.issue.number) {
        return { ...result, fallback: true };
      }
      if (number === second?.issue.number) {
        throw new ModelRefusalError('cyber');
      }
      return result;
    });
    const { refusals, scored } = await summary('mixed', model, 'fake');
    expect(refusals).toEqual({
      cases: scored,
      refusalRate: 1 / scored,
      fallbackRate: 1 / scored,
      declinedByRequestedModel: 2 / scored,
    });
  });
});
