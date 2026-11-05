import type { TriageInput, TriageSuggestion } from '../../src/triage/model.js';

/** A representative triage input for the fictional `lumen-labs/lumen` repository. */
export const sampleInput: TriageInput = {
  repository: 'lumen-labs/lumen',
  issue: {
    number: 42,
    title: 'PDF export fails for dashboards with an empty panel',
    body: "Steps to reproduce:\n\n1. Create a dashboard with one empty panel\n2. Click Export > PDF\n\nExpected a PDF. Got a 500 and `TypeError: cannot read properties of undefined (reading 'series')` in the server log.",
  },
  labels: [
    { name: 'bug', description: "Something isn't working" },
    { name: 'area: export', description: 'PDF and PNG export' },
    { name: 'documentation', description: null },
  ],
  candidates: [
    {
      number: 17,
      title: 'Exporting a dashboard to PDF crashes when a panel has no data',
      state: 'closed',
      excerpt: "Server log shows TypeError reading 'series' of undefined when exporting to PDF.",
    },
  ],
};

/** A suggestion that is valid for {@link sampleInput}. */
export const sampleSuggestion: TriageSuggestion = {
  summary: 'PDF export returns a 500 when a dashboard has an empty panel.',
  labels: { names: ['bug', 'area: export'], confidence: 0.9, rationale: 'A crash in export.' },
  priority: { level: 'high', confidence: 0.7, rationale: 'Export is broken with no workaround.' },
  duplicates: {
    issues: [{ number: 17, reason: 'Same TypeError when exporting an empty panel.' }],
    confidence: 0.8,
    rationale: 'Issue 17 reports the same stack trace.',
  },
};
