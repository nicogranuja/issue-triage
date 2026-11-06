import { labelKey, type LabelChange } from '@issue-triage/shared';

import { safeLabelColor } from '../lib/safe.ts';
import styles from './Labels.module.css';

export type LabelColors = ReadonlyMap<string, string>;

type ChipKind = 'keep' | 'add' | 'remove';

const MARKS: Record<ChipKind, string> = { keep: '', add: '+', remove: '−' };
const SPOKEN: Record<ChipKind, string> = { keep: '', add: 'add', remove: 'remove' };

export function LabelChip({
  name,
  colors,
  kind = 'keep',
  note,
}: {
  name: string;
  colors: LabelColors;
  kind?: ChipKind;
  note?: string | undefined;
}) {
  const color = safeLabelColor(colors.get(labelKey(name)));
  return (
    <li className={styles.chip} data-kind={kind}>
      {kind !== 'keep' && (
        <span className={styles.mark} aria-hidden="true">
          {MARKS[kind]}
        </span>
      )}
      {SPOKEN[kind] && <span className="visually-hidden">{SPOKEN[kind]}: </span>}
      <span
        className={styles.swatch}
        style={color ? { backgroundColor: color } : undefined}
        aria-hidden="true"
      />
      <span className={styles.name}>{name}</span>
      {note && <span className={styles.note}>{note}</span>}
    </li>
  );
}

/**
 * A review's effect on the issue's labels: the labels it keeps, and those it adds (+) and
 * removes (−). Each change is marked with a sign and announced in words, not only by color.
 */
export function LabelDiff({
  change,
  colors,
  missing,
  priorityLabel,
  label,
}: {
  change: LabelChange;
  colors: LabelColors;
  /** Labels the repository no longer has: the write-back will skip them. */
  missing: ReadonlySet<string>;
  priorityLabel?: string | undefined;
  /** Accessible name of the list. */
  label: string;
}) {
  const isPriority = (name: string) =>
    priorityLabel !== undefined && labelKey(name) === labelKey(priorityLabel);
  const noteFor = (name: string) => {
    if (missing.has(labelKey(name))) {
      return 'no longer in the repository; skipped';
    }
    return isPriority(name) ? 'priority' : undefined;
  };
  if (change.final.length === 0 && change.remove.length === 0) {
    return <p className={styles.empty}>No labels</p>;
  }
  return (
    <ul className={styles.list} aria-label={label}>
      {change.add.map((name) => (
        <LabelChip
          key={`add:${name}`}
          name={name}
          colors={colors}
          kind="add"
          note={noteFor(name)}
        />
      ))}
      {change.remove.map((name) => (
        <LabelChip key={`remove:${name}`} name={name} colors={colors} kind="remove" />
      ))}
      {change.keep.map((name) => (
        <LabelChip key={`keep:${name}`} name={name} colors={colors} />
      ))}
    </ul>
  );
}
