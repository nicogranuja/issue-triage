import type { Priority } from '@issue-triage/shared';

import { PRIORITY_NAMES } from '../lib/format.ts';
import styles from './Priority.module.css';

const BARS: Record<Exclude<Priority, 'urgent'>, number> = { high: 3, medium: 2, low: 1 };

/**
 * A priority as an icon plus its name. The icon's shape carries the level (bars filled, or an
 * exclamation mark for urgent), so it reads without color too.
 */
export function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === 'urgent') {
    return (
      <svg className={styles.icon} data-priority="urgent" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
        <path d="M8 4.5v4.5M8 11.2v.3" />
      </svg>
    );
  }
  const filled = BARS[priority];
  return (
    <svg className={styles.icon} data-priority={priority} viewBox="0 0 16 16" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={2 + index * 4.5}
          y={10 - index * 3.5}
          width="3"
          height={4 + index * 3.5}
          rx="1"
          data-filled={index < filled}
        />
      ))}
    </svg>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={styles.badge}>
      <PriorityIcon priority={priority} />
      {PRIORITY_NAMES[priority]}
    </span>
  );
}
