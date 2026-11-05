import { describe, expect, it } from 'vitest';

import { keywordSuggestion } from '../../src/triage/fake-model.js';
import type { TriageSuggestion } from '../../src/triage/model.js';
import {
  outputContext,
  outputJsonSchema,
  parseSuggestion,
  type OutputContext,
} from '../../src/triage/output.js';
import { sampleInput, sampleSuggestion } from '../helpers/triage.js';

const context: OutputContext = outputContext(sampleInput);

const valid: TriageSuggestion = sampleSuggestion;

function withChanges(change: (copy: TriageSuggestion) => void): string {
  const copy = structuredClone(valid);
  change(copy);
  return JSON.stringify(copy);
}

function problemsOf(text: string, ctx = context): string[] {
  const result = parseSuggestion(text, ctx);
  if (result.success) {
    throw new Error('Expected validation to fail');
  }
  return result.problems;
}

describe('parseSuggestion', () => {
  it('accepts a valid suggestion', () => {
    expect(parseSuggestion(JSON.stringify(valid), context)).toEqual({
      success: true,
      suggestion: valid,
    });
  });

  it('rejects a label that is not in the repository', () => {
    const text = withChanges((s) => {
      s.labels.names = ['bug', 'priority: p0'];
    });
    expect(problemsOf(text)).toEqual([
      `labels.names.1: "priority: p0" is not one of the repository's labels`,
    ]);
  });

  it('rejects labels that differ only in case', () => {
    const text = withChanges((s) => {
      s.labels.names = ['Bug'];
    });
    expect(problemsOf(text)).toHaveLength(1);
  });

  it('rejects any label when the repository has none', () => {
    expect(problemsOf(JSON.stringify(valid), { ...context, labelNames: [] })).toHaveLength(2);
  });

  it('rejects a repeated label', () => {
    const text = withChanges((s) => {
      s.labels.names = ['bug', 'bug'];
    });
    expect(problemsOf(text)).toEqual(['labels.names: lists a label more than once']);
  });

  it('rejects a duplicate that was not among the candidates', () => {
    const text = withChanges((s) => {
      s.duplicates.issues = [{ number: 999, reason: 'Looks similar.' }];
    });
    expect(problemsOf(text)).toEqual([
      'duplicates.issues.0.number: #999 is not one of the candidate issues',
    ]);
  });

  it('rejects out-of-range confidence and an unknown priority', () => {
    const text = JSON.stringify({
      ...valid,
      labels: { ...valid.labels, confidence: 1.5 },
      priority: { ...valid.priority, level: 'critical' },
    });
    const problems = problemsOf(text);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^labels\.confidence: /);
    expect(problems[1]).toMatch(/^priority\.level: /);
  });

  it('rejects an empty summary and missing fields', () => {
    expect(problemsOf(JSON.stringify({ ...valid, summary: '  ' }))[0]).toMatch(/^summary: /);
    expect(problemsOf(JSON.stringify({ summary: 'Only a summary.' }))).toHaveLength(3);
  });

  it('rejects text that is not JSON', () => {
    expect(problemsOf('Here are my suggestions: {"summary": ')).toEqual([
      'the reply is not a single valid JSON object',
    ]);
  });
});

describe('outputJsonSchema', () => {
  it('constrains label names to the repository set and priorities to the shared enum', () => {
    const schema = outputJsonSchema(['bug', 'area: export']) as {
      properties: {
        labels: { properties: { names: { items: unknown } } };
        priority: { properties: { level: unknown } };
      };
    };
    expect(schema.properties.labels.properties.names.items).toEqual({
      type: 'string',
      enum: ['bug', 'area: export'],
    });
    expect(schema.properties.priority.properties.level).toEqual({
      type: 'string',
      enum: ['urgent', 'high', 'medium', 'low'],
    });
  });

  it('does not depend on the issue, so the provider can reuse it for the whole repository', () => {
    expect(outputJsonSchema(['bug'])).toEqual(outputJsonSchema(['bug']));
    expect(JSON.stringify(outputJsonSchema(['bug']))).not.toContain('17');
  });

  it('closes every object and requires every property', () => {
    const objects: Record<string, unknown>[] = [];
    const visit = (node: unknown) => {
      if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (record.type === 'object') {
          objects.push(record);
        }
        Object.values(record).forEach(visit);
      }
    };
    visit(outputJsonSchema([]));

    expect(objects.length).toBeGreaterThan(3);
    for (const schema of objects) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties as object));
    }
  });
});

describe('keywordSuggestion (fake model)', () => {
  it('produces output that passes the same validation as a real model', () => {
    const suggestion = keywordSuggestion(sampleInput);

    expect(parseSuggestion(JSON.stringify(suggestion), context).success).toBe(true);
    expect(suggestion.labels.names).toEqual(['area: export']);
    expect(suggestion.priority.level).toBe('high');
  });
});
