import { confidenceBand, labelKey, type QueueItem } from '@issue-triage/shared';

import { PRIORITY_NAMES, plural, timeAgo } from '../lib/format.ts';
import { PriorityIcon } from './Priority.tsx';
import styles from './QueueList.module.css';

export interface QueueListProps {
  items: readonly QueueItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  /** Called with each row's button, so the parent can move focus with the selection. */
  registerItem: (id: number, element: HTMLButtonElement | null) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function newLabels(item: QueueItem): number {
  const current = new Set(item.issue.labels.map(labelKey));
  return item.labels.filter((name) => !current.has(labelKey(name))).length;
}

/**
 * The queue as a list of buttons with a roving tab stop: only the selected row is in the Tab
 * order, and j/k (or the arrow keys) move the selection and focus together.
 */
export function QueueList({
  items,
  selectedId,
  onSelect,
  onOpen,
  registerItem,
  hasMore,
  loadingMore,
  onLoadMore,
}: QueueListProps) {
  const tabStop = items.some((item) => item.suggestionId === selectedId)
    ? selectedId
    : (items[0]?.suggestionId ?? null);
  return (
    <>
      <ol className={styles.list} aria-label="Suggestions to review">
        {items.map((item) => {
          const selected = item.suggestionId === selectedId;
          const added = newLabels(item);
          const band = confidenceBand(item.confidence);
          return (
            <li key={item.suggestionId}>
              <button
                type="button"
                ref={(element) => {
                  registerItem(item.suggestionId, element);
                }}
                className={styles.row}
                aria-current={selected ? 'true' : undefined}
                tabIndex={item.suggestionId === tabStop ? 0 : -1}
                onClick={() => {
                  onSelect(item.suggestionId);
                  onOpen(item.suggestionId);
                }}
                onFocus={() => {
                  if (!selected) {
                    onSelect(item.suggestionId);
                  }
                }}
              >
                <span className={styles.top}>
                  <PriorityIcon priority={item.priority} />
                  <span className="visually-hidden">
                    {PRIORITY_NAMES[item.priority]} priority,{' '}
                  </span>
                  <span className={styles.title}>{item.issue.title}</span>
                </span>
                <span className={styles.meta}>
                  <span className={styles.number}>
                    {item.repository.fullName.split('/')[1]}#{item.issue.number}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{added > 0 ? `+${plural(added, 'label')}` : 'No new labels'}</span>
                  {band === 'low' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className={styles.unsure}>Low confidence</span>
                    </>
                  )}
                  <span className={styles.age}>
                    <span className="visually-hidden">opened </span>
                    {timeAgo(item.issue.openedAt)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <button type="button" className={styles.more} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}

export function QueueSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <span style={{ inlineSize: `${60 + ((index * 17) % 35)}%` }} />
          <span style={{ inlineSize: '40%' }} />
        </div>
      ))}
    </div>
  );
}
