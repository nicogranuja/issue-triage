/**
 * Domain vocabulary shared by the API (database enums, validation) and the web app (UI state).
 * Each list is the single source of truth for its union type.
 */

/** Lifecycle state of a GitHub issue, mirrored from GitHub. */
export const ISSUE_STATES = ['open', 'closed'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/**
 * Why an issue no longer exists in its repository. Removed issues are kept (their history and
 * reviews stay intact) but never triaged again and never shown in the review queue.
 */
export const ISSUE_REMOVAL_REASONS = ['deleted', 'transferred'] as const;
export type IssueRemovalReason = (typeof ISSUE_REMOVAL_REASONS)[number];

/** Priority levels a triage suggestion can propose and a reviewer can set, most urgent first. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Where a triage suggestion is in the review flow. A suggestion is `superseded` when it stops
 * applying before anyone reviewed it: a newer suggestion replaced it, or the issue was deleted
 * or transferred.
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

/**
 * What a queued job does. `triage` asks the model for a suggestion; `write_back` applies a
 * reviewed suggestion's labels to the issue on GitHub. Both share one queue table, so a review
 * and its write-back job commit in the same transaction (an outbox).
 */
export const JOB_KINDS = ['triage', 'write_back'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

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

/** What one run of a write-back job changed on GitHub. */
export interface WriteBackAttempt {
  /** Which run of the job this was, starting at 1. */
  attempt: number;
  added: string[];
  removed: string[];
  /** Labels this run did not apply because the repository no longer has them. */
  skipped: string[];
  /**
   * Labels this run left alone because someone changed them on GitHub after the review: a label
   * the review adds that was taken off since, or one it removes that was put back since.
   */
  kept: string[];
}

/**
 * What a write-back job did to the issue's labels on GitHub, over all its runs. A run can fail
 * part-way (a rate limit after the labels were added, say), and the retry then finds part of the
 * change already made; the totals merge every run, and `attempts` says which run did what.
 */
export interface WriteBackResult {
  /** Labels added to the issue, by any run. */
  added: string[];
  /** Labels removed from the issue, by any run. */
  removed: string[];
  /** Labels the review asked for that no longer exist in the repository, so were not applied. */
  skipped: string[];
  /** Labels left as someone changed them on GitHub after the review. Absent on old rows. */
  kept?: string[];
  /** True when the job only planned the change (`WRITE_BACK_MODE=dry-run`) and wrote nothing. */
  dryRun: boolean;
  /** Each run that got as far as working out the change, oldest first. Absent on old rows. */
  attempts?: WriteBackAttempt[];
}
