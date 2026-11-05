/**
 * Domain vocabulary shared by the API (database enums, validation) and the web app (UI state).
 * Each list is the single source of truth for its union type.
 */

/** Lifecycle state of a GitHub issue, mirrored from GitHub. */
export const ISSUE_STATES = ['open', 'closed'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** Priority levels a triage suggestion can propose and a reviewer can set, most urgent first. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Where a triage suggestion is in the review flow. A suggestion is `superseded` when the issue
 * changes and a newer suggestion replaces it before anyone reviewed it.
 */
export const SUGGESTION_STATUSES = ['pending', 'reviewed', 'superseded'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/**
 * Where a triage job is in the queue. `pending` jobs wait for their `run_after` time, `running`
 * jobs hold a lease, and the other three are final. `cancelled` means the work became pointless,
 * for example because the issue was deleted before the job ran.
 */
export const TRIAGE_JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TriageJobStatus = (typeof TRIAGE_JOB_STATUSES)[number];

/** What a reviewer did with a suggestion. */
export const REVIEW_DECISIONS = ['accepted', 'edited', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** An existing issue that a suggestion flags as a likely duplicate. */
export interface DuplicateCandidate {
  /** Internal id of the existing issue. */
  issueId: number;
  /** Why the issues look like duplicates, shown to the reviewer. */
  reason: string;
}
