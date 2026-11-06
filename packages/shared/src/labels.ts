import type { Priority } from './domain.js';

/**
 * Which label, if any, stands for each priority on GitHub. Configured per deployment
 * (`PRIORITY_LABELS`); a priority without a label is kept in this app only.
 */
export type PriorityLabels = Partial<Record<Priority, string>>;

/** A change to an issue's labels, as the review UI shows it and the write-back applies it. */
export interface LabelChange {
  /** Labels to add: wanted, and not on the issue yet. */
  add: string[];
  /** Labels to take off the issue. Only ever ones the reviewer removed. */
  remove: string[];
  /** Labels on the issue that stay. */
  keep: string[];
  /** The issue's labels after the change: `keep` then `add`. */
  final: string[];
}

export interface LabelChangeInput {
  /** The issue's labels now. */
  current: readonly string[];
  /** The labels the issue should have: the suggestion's, or the reviewer's edited selection. */
  target: readonly string[];
  /**
   * Whether labels on the issue but missing from `target` are removed. True for an edit, where
   * the reviewer saw every current label and unticked some; false when accepting a suggestion,
   * which only ever adds.
   */
  removeUnlisted: boolean;
  /**
   * With `removeUnlisted`: the labels the reviewer saw on the issue when they edited it. Only
   * these can be removed; a label added to the issue since then is kept, because the reviewer
   * never had the chance to keep it. Defaults to `current`.
   */
  seen?: readonly string[] | undefined;
  /** The label for the chosen priority, if one is mapped. It is added, and never removed. */
  priorityLabel?: string | undefined;
}

/** GitHub label names are unique regardless of case: `Bug` and `bug` are the same label. */
export function labelKey(name: string): string {
  return name.toLowerCase();
}

/** Removes duplicates (ignoring case), keeping the first spelling and the order. */
export function uniqueLabels(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = labelKey(name);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(name);
    }
  }
  return unique;
}

/**
 * Works out how a review changes an issue's labels. Shared by the review UI, which previews the
 * change as a diff, and the API, which stores it for the write-back, so the reviewer sees exactly
 * what will be written.
 *
 * Accepting a suggestion only adds labels. Labels are removed only in an edit, and only those the
 * reviewer saw on the issue and explicitly took off. Choosing a priority adds its mapped label but does not remove the
 * labels of other priorities: that would be a removal the reviewer never made.
 */
export function planLabelChange({
  current,
  target,
  removeUnlisted,
  seen,
  priorityLabel,
}: LabelChangeInput): LabelChange {
  const currentLabels = uniqueLabels(current);
  const currentKeys = new Set(currentLabels.map(labelKey));
  const wanted = uniqueLabels(priorityLabel ? [...target, priorityLabel] : target);
  const wantedKeys = new Set(wanted.map(labelKey));

  const add = wanted.filter((name) => !currentKeys.has(labelKey(name)));
  const seenKeys = new Set((seen ?? current).map(labelKey));
  const remove = removeUnlisted
    ? currentLabels.filter(
        (name) => seenKeys.has(labelKey(name)) && !wantedKeys.has(labelKey(name)),
      )
    : [];
  const removeKeys = new Set(remove.map(labelKey));
  const keep = currentLabels.filter((name) => !removeKeys.has(labelKey(name)));
  return { add, remove, keep, final: [...keep, ...add] };
}
