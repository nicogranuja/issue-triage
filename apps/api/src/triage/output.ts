import { PRIORITIES } from '@issue-triage/shared';
import { z } from 'zod';

import type { TriageInput, TriageSuggestion } from './model.js';

/**
 * The output contract: a JSON schema the provider enforces while the model writes, and a Zod
 * schema that this app enforces afterwards. Both are needed. The JSON schema constrains decoding,
 * which keeps labels inside the repository's set (`enum`) and makes malformed output rare. The
 * Zod schema is the check we actually trust: it also covers what JSON schema cannot express
 * here (ranges, lengths, uniqueness, duplicates restricted to the candidates we sent), and it
 * runs on every provider's output, including providers that don't constrain decoding at all.
 */

export const MAX_LABELS = 5;
const MAX_SUMMARY_CHARS = 600;
const MAX_REASON_CHARS = 400;

type JsonSchema = Record<string, unknown>;

const judgement = (subject: string): Record<string, JsonSchema> => ({
  confidence: {
    type: 'number',
    description: `0 to 1: how likely a maintainer agrees with the ${subject}.`,
  },
  rationale: { type: 'string', description: `One sentence explaining the ${subject}.` },
});

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * The JSON schema sent as `output_config.format`. Written by hand rather than generated from the
 * Zod schema: the SDK's converter turns `enum` into description text, which would drop the label
 * constraint. It depends only on the label set, not on the issue, so the provider compiles it
 * once per repository instead of once per request.
 */
export function outputJsonSchema(labelNames: readonly string[]): JsonSchema {
  const labelName: JsonSchema =
    labelNames.length > 0
      ? { type: 'string', enum: [...labelNames] }
      : { type: 'string', description: 'The repository has no labels: leave the list empty.' };

  return object({
    summary: {
      type: 'string',
      description: 'One to three plain sentences: what is wrong or requested, and where.',
    },
    labels: object({
      names: { type: 'array', items: labelName, description: `At most ${MAX_LABELS}.` },
      ...judgement('labels'),
    }),
    priority: object({
      level: { type: 'string', enum: [...PRIORITIES] },
      ...judgement('priority'),
    }),
    duplicates: object({
      issues: {
        type: 'array',
        description: 'Candidates that report the same problem. Usually empty.',
        items: object({
          number: { type: 'integer', description: 'The candidate issue number.' },
          reason: { type: 'string', description: 'One sentence on why it is a duplicate.' },
        }),
      },
      ...judgement('duplicate assessment'),
    }),
  });
}

/** What a suggestion may refer to: the labels and candidates in the prompt, nothing else. */
export interface OutputContext {
  labelNames: readonly string[];
  candidateNumbers: readonly number[];
}

export function outputContext(input: TriageInput): OutputContext {
  return {
    labelNames: input.labels.map((label) => label.name),
    candidateNumbers: input.candidates.map((candidate) => candidate.number),
  };
}

const unique = (values: readonly unknown[]) => new Set(values).size === values.length;

/** The Zod schema for a suggestion, bound to the labels and candidates it may use. */
export function suggestionSchema({
  labelNames,
  candidateNumbers,
}: OutputContext): z.ZodType<TriageSuggestion> {
  const allowedLabels = new Set(labelNames);
  const allowedCandidates = new Set(candidateNumbers);
  const confidence = z.number().min(0).max(1);
  const sentence = z.string().trim().min(1).max(MAX_REASON_CHARS);

  return z.object({
    summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
    labels: z.object({
      names: z
        .array(
          z.string().refine((name) => allowedLabels.has(name), {
            error: (issue) =>
              `${JSON.stringify(issue.input)} is not one of the repository's labels`,
          }),
        )
        .max(MAX_LABELS)
        .refine(unique, 'lists a label more than once'),
      confidence,
      rationale: sentence,
    }),
    priority: z.object({ level: z.enum(PRIORITIES), confidence, rationale: sentence }),
    duplicates: z.object({
      issues: z
        .array(
          z.object({
            number: z
              .number()
              .int()
              .refine((number) => allowedCandidates.has(number), {
                error: (issue) => `#${String(issue.input)} is not one of the candidate issues`,
              }),
            reason: sentence,
          }),
        )
        .refine((issues) => unique(issues.map((issue) => issue.number)), 'lists an issue twice'),
      confidence,
      rationale: sentence,
    }),
  });
}

export type ParseResult =
  { success: true; suggestion: TriageSuggestion } | { success: false; problems: string[] };

/** Parses and validates the model's text output. Problems are phrased for the model to fix. */
export function parseSuggestion(text: string, context: OutputContext): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { success: false, problems: ['the reply is not a single valid JSON object'] };
  }
  const parsed = suggestionSchema(context).safeParse(json);
  if (parsed.success) {
    return { success: true, suggestion: parsed.data };
  }
  return {
    success: false,
    problems: parsed.error.issues.slice(0, 10).map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}
