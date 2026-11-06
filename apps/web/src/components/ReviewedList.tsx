import type { RecentReviewsResponse, Review } from '@issue-triage/shared';

import { timeAgo } from '../lib/format.ts';
import { safeHttpUrl } from '../lib/safe.ts';
import styles from './ReviewedList.module.css';

type Item = RecentReviewsResponse['items'][number];

const DECISIONS: Record<Review['decision'], string> = {
  accepted: 'Accepted',
  edited: 'Edited',
  rejected: 'Rejected',
};

function list(names: string[]): string {
  return names.join(', ');
}

/** What happened to the review on GitHub, in words. `last_error` is shown as plain text. */
function writeBackStatus(review: Review): { text: string; tone: 'muted' | 'ok' | 'error' } {
  const job = review.writeBack;
  if (!job) {
    return {
      text: review.decision === 'rejected' ? 'Nothing to write.' : 'No label changes to write.',
      tone: 'muted',
    };
  }
  switch (job.status) {
    case 'pending':
      return job.attempts === 0
        ? { text: `Writing to GitHub ${timeAgo(job.runAfter)}.`, tone: 'muted' }
        : { text: `Will retry: ${job.lastError ?? 'unknown error'}`, tone: 'error' };
    case 'running':
      return { text: 'Writing to GitHub…', tone: 'muted' };
    case 'failed':
      return { text: `Failed: ${job.lastError ?? 'unknown error'}`, tone: 'error' };
    case 'cancelled':
      return { text: `Cancelled: ${job.lastError ?? 'no longer needed'}`, tone: 'muted' };
    case 'succeeded': {
      const result = job.result;
      if (!result) {
        return { text: 'Written to GitHub.', tone: 'ok' };
      }
      const parts = [
        result.added.length > 0 && `added ${list(result.added)}`,
        result.removed.length > 0 && `removed ${list(result.removed)}`,
      ].filter((part) => part !== false);
      const done = parts.length > 0 ? parts.join('; ') : 'already up to date';
      const skipped =
        result.skipped.length > 0
          ? ` Skipped (no longer in the repository): ${list(result.skipped)}.`
          : '';
      return {
        text: result.dryRun
          ? `Dry run, nothing written: would have ${done}.${skipped}`
          : `Written: ${done}.${skipped}`,
        tone: 'ok',
      };
    }
  }
}

function undoable(review: Review): boolean {
  return review.writeBack === null
    ? review.decision === 'rejected'
    : review.writeBack.status === 'pending' && review.writeBack.attempts === 0;
}

export function ReviewedList({
  items,
  onUndo,
  undoing,
}: {
  items: Item[];
  onUndo: (suggestionId: number) => void;
  undoing: boolean;
}) {
  if (items.length === 0) {
    return <p className={styles.empty}>Nothing reviewed yet.</p>;
  }
  return (
    <ol className={styles.list} aria-label="Recent reviews">
      {items.map(({ review, issue, repository }) => {
        const status = writeBackStatus(review);
        const url = safeHttpUrl(issue.htmlUrl);
        const name = `${repository.fullName.split('/')[1] ?? ''}#${issue.number}`;
        return (
          <li key={review.id} className={styles.item}>
            <p className={styles.top}>
              <span className={styles.decision} data-decision={review.decision}>
                {DECISIONS[review.decision]}
              </span>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className={styles.title}>
                  {name} {issue.title}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className={styles.title}>
                  {name} {issue.title}
                </span>
              )}
              <span className={styles.age}>{timeAgo(review.createdAt)}</span>
            </p>
            <p className={styles.status} data-tone={status.tone}>
              {status.text}
            </p>
            {review.note && <p className={styles.note}>Note: {review.note}</p>}
            {undoable(review) && (
              <button
                type="button"
                className={styles.undo}
                disabled={undoing}
                onClick={() => {
                  onUndo(review.suggestionId);
                }}
              >
                Undo
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
