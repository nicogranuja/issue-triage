import { describe, expect, it } from 'vitest';

import { candidatesFor, CASE_TAGS, loadFixtures, triageInputFor } from '../../evals/cases.js';
import { MAX_BODY_CHARS, PROMPTS } from '../../src/triage/prompt.js';

const fixtures = loadFixtures();
const cases = fixtures.flatMap((fixture) => fixture.cases.map((c) => ({ fixture, c })));

describe('eval fixtures', () => {
  it('cover three repositories and 40 to 60 cases, with unique ids', () => {
    expect(fixtures.map((fixture) => fixture.repository)).toHaveLength(3);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.length).toBeLessThanOrEqual(60);
    const ids = cases.map(({ c }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('include every kind of hard case', () => {
    const tags = new Set(cases.flatMap(({ c }) => c.tags));
    expect(CASE_TAGS.filter((tag) => !tags.has(tag))).toEqual([]);
    // Each injection case says what it tries to make the triage do.
    for (const { c } of cases.filter(({ c }) => c.tags.includes('injection'))) {
      expect(c.injection, c.id).toBeDefined();
    }
  });

  it('make the very long cases longer than what the prompt sends', () => {
    for (const { c } of cases.filter(({ c }) => c.tags.includes('very-long'))) {
      expect(c.issue.body?.length, c.id).toBeGreaterThan(MAX_BODY_CHARS);
    }
  });

  it('give every hand-written case a reference summary and known duplicates', () => {
    for (const { fixture, c } of cases) {
      expect(fixture.source).toBe('hand-written');
      expect(c.expected.summary, c.id).not.toBeNull();
      expect(c.expected.duplicates, c.id).not.toBeNull();
    }
  });

  it('show which known duplicates the pre-filter misses', () => {
    // A duplicate missing from the candidates can never be found by the model, so a miss shows up
    // as low duplicate recall. atlas-13 is a paraphrase ("fuzzy on a Retina MacBook" against
    // "blurry on high-DPI screens") with no shared words, the known weakness of a TF-IDF
    // pre-filter (see duplicates.ts). It stays in the set as a measured limitation.
    const missed = cases.flatMap(({ fixture, c }) => {
      const sent = new Set(candidatesFor(fixture, c).map((candidate) => candidate.number));
      return (c.expected.duplicates ?? [])
        .filter((number) => !sent.has(number))
        .map((n) => `${c.id}→#${n}`);
    });
    expect(missed).toEqual(['atlas-13→#309']);
  });

  it('build the same input the worker sends, with only the repository labels', () => {
    const { fixture, c } = cases[0] ?? {};
    if (!fixture || !c) {
      throw new Error('No cases');
    }
    const input = triageInputFor(fixture, c);
    expect(input.labels).toEqual(fixture.labels);
    expect(input.issue).toEqual(c.issue);
  });

  it('share no text with the prompts, so nothing about a case leaks into the instructions', () => {
    const empty = { repository: 'x/y', issue: { number: 1, title: 't', body: null } };
    const instructions = Object.values(PROMPTS)
      .map((prompt) => prompt.systemPrompt({ ...empty, labels: [], candidates: [] })[0])
      .join('\n')
      .toLowerCase();
    for (const { fixture, c } of cases) {
      expect(instructions, c.id).not.toContain(c.issue.title.toLowerCase());
      expect(instructions).not.toContain(fixture.repository.toLowerCase());
    }
  });
});
