import {
  labelKey,
  planLabelChange,
  PRIORITIES,
  type Priority,
  type ReviewRequest,
  type SuggestionDetail,
} from '@issue-triage/shared';
import { useId, useMemo, useRef, useState, type SyntheticEvent, type KeyboardEvent } from 'react';

import { PRIORITY_NAMES } from '../lib/format.ts';
import { safeLabelColor } from '../lib/safe.ts';
import styles from './EditForm.module.css';
import { LabelDiff, type LabelColors } from './Labels.tsx';

interface EditFormProps {
  detail: SuggestionDetail;
  colors: LabelColors;
  missing: ReadonlySet<string>;
  submitting: boolean;
  onSubmit: (request: ReviewRequest) => void;
  onCancel: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Edit mode: the reviewer picks the issue's labels from the repository's own set, a priority,
 * and an optional note. The ticked labels are the full set the issue should have, so unticking a
 * current label removes it; the live diff underneath shows exactly what will be written.
 */
export function EditForm({
  detail,
  colors,
  missing,
  submitting,
  onSubmit,
  onCancel,
}: EditFormProps) {
  const id = useId();
  const [priority, setPriority] = useState<Priority>(detail.priority.level);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set([...detail.issue.labels, ...detail.labels.names].map(labelKey)),
  );
  const filterRef = useRef<HTMLInputElement>(null);

  // The repository's labels, plus any current label it has since deleted, so it can be kept
  // or removed explicitly.
  const options = useMemo(() => {
    const names = [
      ...(detail.repository.labels?.map((label) => label.name) ?? detail.labels.names),
      ...detail.issue.labels,
    ];
    const byKey = new Map<string, string>();
    for (const name of names) {
      if (!byKey.has(labelKey(name))) {
        byKey.set(labelKey(name), name);
      }
    }
    return [...byKey.values()];
  }, [detail]);
  const descriptions = useMemo(
    () =>
      new Map(detail.repository.labels?.map((label) => [labelKey(label.name), label.description])),
    [detail],
  );

  const priorityLabel = detail.priorityLabels[priority];
  const priorityKey = priorityLabel === undefined ? undefined : labelKey(priorityLabel);
  const chosen = options.filter((name) => selected.has(labelKey(name)));
  const change = planLabelChange({
    current: detail.issue.labels,
    target: chosen,
    removeUnlisted: true,
    priorityLabel,
  });

  const query = filter.trim().toLowerCase();
  const visible =
    query === '' ? options : options.filter((name) => name.toLowerCase().includes(query));

  const toggle = (name: string) => {
    const key = labelKey(name);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (submitting) {
      return;
    }
    onSubmit({
      decision: 'edit',
      labels: chosen,
      baseLabels: detail.issue.labels,
      priority,
      ...(note.trim() !== '' && { note: note.trim() }),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className={styles.title}>
        Edit before applying
      </h3>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Labels</legend>
        <input
          ref={filterRef}
          type="search"
          className={styles.filter}
          placeholder="Filter labels…"
          aria-label="Filter labels"
          aria-controls={`${id}-labels`}
          value={filter}
          autoFocus
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter toggles the first match, so "reg⏎" ticks "regression".
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              const [first] = visible;
              if (first !== undefined) {
                toggle(first);
                setFilter('');
              }
            }
          }}
        />
        <ul id={`${id}-labels`} className={styles.options}>
          {visible.map((name) => {
            const key = labelKey(name);
            const forced = key === priorityKey;
            const color = safeLabelColor(
              detail.repository.labels?.find((label) => labelKey(label.name) === key)?.color,
            );
            const description = descriptions.get(key);
            return (
              <li key={key}>
                <label className={styles.option} data-forced={forced || undefined}>
                  <input
                    type="checkbox"
                    checked={forced || selected.has(key)}
                    disabled={forced}
                    onChange={() => {
                      toggle(name);
                    }}
                  />
                  <span
                    className={styles.swatch}
                    style={color ? { backgroundColor: color } : undefined}
                    aria-hidden="true"
                  />
                  <span className={styles.optionName}>{name}</span>
                  {forced ? (
                    <span className={styles.optionNote}>set by priority</span>
                  ) : (
                    description && <span className={styles.optionNote}>{description}</span>
                  )}
                </label>
              </li>
            );
          })}
          {visible.length === 0 && <li className={styles.none}>No label matches “{filter}”.</li>}
        </ul>
        {detail.repository.labels === null && (
          <p className={styles.hint}>
            The repository’s label set hasn’t been fetched yet, so only current and suggested labels
            are listed.
          </p>
        )}
      </fieldset>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.legend}>Priority</span>
          <select
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as Priority);
            }}
          >
            {PRIORITIES.map((level) => (
              <option key={level} value={level}>
                {PRIORITY_NAMES[level]}
                {detail.priorityLabels[level] ? ` (label “${detail.priorityLabels[level]}”)` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.legend}>
          Note <span className={styles.optional}>(optional, kept with the review)</span>
        </span>
        <textarea
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>

      <div className={styles.preview}>
        <span className={styles.legend} id={`${id}-preview`}>
          Will be written
        </span>
        <LabelDiff
          change={change}
          colors={colors}
          missing={missing}
          priorityLabel={priorityLabel}
          label="Labels after this edit"
        />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={submitting}>
          Save and apply <kbd aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} ↵</kbd>
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Cancel <kbd aria-hidden="true">Esc</kbd>
        </button>
      </div>
    </form>
  );
}
