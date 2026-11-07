import { ISSUE_STATES } from '@issue-triage/shared';
import { z } from 'zod';

/**
 * Zod schemas for the parts of GitHub webhook payloads we use. Unknown fields are stripped, so
 * GitHub adding fields never breaks ingestion; a field we rely on changing shape fails loudly.
 */

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const accountSchema = z.object({
  login: z.string().min(1),
});

export const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  owner: accountSchema,
});

export const issueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.enum(ISSUE_STATES),
  state_reason: z.string().nullish(),
  labels: z.array(z.object({ name: z.string().min(1) })).default([]),
  user: accountSchema.nullable(),
  html_url: z.url(),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: timestamp.nullable(),
});

/** `issues` actions that change data we mirror. Others (assigned, pinned, ...) are ignored. */
export const HANDLED_ISSUE_ACTIONS = [
  'opened',
  'edited',
  'reopened',
  'closed',
  'labeled',
  'unlabeled',
  'deleted',
  'transferred',
] as const;
export type HandledIssueAction = (typeof HANDLED_ISSUE_ACTIONS)[number];

/**
 * Actions after which the issue needs (new) triage: its text is new or changed, or it is open
 * again. Label and state changes alone don't change what the issue is about.
 */
export const TRIAGE_ISSUE_ACTIONS = [
  'opened',
  'edited',
  'reopened',
] as const satisfies readonly HandledIssueAction[];

/**
 * Actions after which the issue is gone from its repository. A transferred issue lives on in
 * another repository under a new id; this one is retired.
 */
export const REMOVAL_ISSUE_ACTIONS = [
  'deleted',
  'transferred',
] as const satisfies readonly HandledIssueAction[];

export const issuesEventSchema = z.object({
  action: z.enum(HANDLED_ISSUE_ACTIONS),
  issue: issueSchema,
  repository: repositorySchema,
});
export type IssuesEvent = z.infer<typeof issuesEventSchema>;

export function isHandledIssueAction(action: string | null): action is HandledIssueAction {
  return (HANDLED_ISSUE_ACTIONS as readonly (string | null)[]).includes(action);
}

/** Reads the top-level `action` most events carry, without validating anything else. */
export function readAction(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'action' in payload) {
    return typeof payload.action === 'string' ? payload.action : null;
  }
  return null;
}

/**
 * `label` actions that change a repository's label set. Each one makes the cached set stale, so the
 * next triage job fetches it again instead of waiting out the cache's lifetime.
 */
export const LABEL_ACTIONS = ['created', 'edited', 'deleted'] as const;

export const labelEventSchema = z.object({
  action: z.enum(LABEL_ACTIONS),
  repository: repositorySchema.pick({ id: true, full_name: true }),
});
export type LabelEvent = z.infer<typeof labelEventSchema>;

export function isLabelAction(action: string | null): action is (typeof LABEL_ACTIONS)[number] {
  return (LABEL_ACTIONS as readonly (string | null)[]).includes(action);
}
