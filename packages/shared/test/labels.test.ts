import { describe, expect, it } from 'vitest';

import { planLabelChange, uniqueLabels } from '../src/labels.js';

describe('planLabelChange', () => {
  it('only adds when a suggestion is accepted', () => {
    expect(
      planLabelChange({
        current: ['needs triage', 'bug'],
        target: ['bug', 'area: export'],
        removeUnlisted: false,
      }),
    ).toEqual({
      add: ['area: export'],
      remove: [],
      keep: ['needs triage', 'bug'],
      final: ['needs triage', 'bug', 'area: export'],
    });
  });

  it('removes only the current labels an edit left out', () => {
    expect(
      planLabelChange({
        current: ['needs triage', 'bug'],
        target: ['bug', 'regression'],
        removeUnlisted: true,
      }),
    ).toEqual({
      add: ['regression'],
      remove: ['needs triage'],
      keep: ['bug'],
      final: ['bug', 'regression'],
    });
  });

  it('compares label names without regard to case, as GitHub does', () => {
    const change = planLabelChange({
      current: ['Bug'],
      target: ['bug', 'BUG', 'docs'],
      removeUnlisted: true,
    });
    expect(change).toEqual({ add: ['docs'], remove: [], keep: ['Bug'], final: ['Bug', 'docs'] });
  });

  it('adds the priority label, and never removes it', () => {
    expect(
      planLabelChange({
        current: ['priority: high'],
        target: [],
        removeUnlisted: true,
        priorityLabel: 'priority: high',
      }),
    ).toEqual({ add: [], remove: [], keep: ['priority: high'], final: ['priority: high'] });

    expect(
      planLabelChange({
        current: ['priority: low'],
        target: ['priority: low'],
        removeUnlisted: false,
        priorityLabel: 'priority: high',
      }),
    ).toMatchObject({ add: ['priority: high'], remove: [] });
  });

  it('changes nothing when the issue already has every label', () => {
    expect(
      planLabelChange({ current: ['bug'], target: ['bug'], removeUnlisted: false }),
    ).toMatchObject({ add: [], remove: [] });
  });
});

describe('uniqueLabels', () => {
  it('keeps the first spelling of each label, in order', () => {
    expect(uniqueLabels(['b', 'A', 'a', 'B', 'c'])).toEqual(['b', 'A', 'c']);
  });
});
