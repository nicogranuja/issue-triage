import { CONFIDENCE_BANDS, PRIORITIES, type QueueFilters } from '@issue-triage/shared';

import { useRepositories } from '../api/queries.ts';
import { PRIORITY_NAMES } from '../lib/format.ts';
import styles from './Filters.module.css';

const CONFIDENCE_NAMES = {
  high: 'High (80% and up)',
  medium: 'Medium (50–79%)',
  low: 'Low (under 50%)',
} as const;

export function Filters({
  filters,
  onChange,
}: {
  filters: QueueFilters;
  onChange: (filters: QueueFilters) => void;
}) {
  const repositories = useRepositories();
  const active = Boolean(filters.repo ?? filters.priority ?? filters.confidence);
  return (
    <div className={styles.filters} role="group" aria-label="Filter the queue">
      <label className={styles.filter}>
        <span className="visually-hidden">Repository</span>
        <select
          value={filters.repo ?? ''}
          onChange={(event) => {
            onChange({ ...filters, repo: event.target.value || undefined });
          }}
        >
          <option value="">All repositories</option>
          {repositories.data?.repositories.map((repository) => (
            <option key={repository.fullName} value={repository.fullName}>
              {repository.fullName} ({repository.pending})
            </option>
          ))}
          {filters.repo &&
            !repositories.data?.repositories.some((r) => r.fullName === filters.repo) && (
              <option value={filters.repo}>{filters.repo}</option>
            )}
        </select>
      </label>
      <label className={styles.filter}>
        <span className="visually-hidden">Priority</span>
        <select
          value={filters.priority ?? ''}
          onChange={(event) => {
            const value = PRIORITIES.find((level) => level === event.target.value);
            onChange({ ...filters, priority: value });
          }}
        >
          <option value="">Any priority</option>
          {PRIORITIES.map((level) => (
            <option key={level} value={level}>
              {PRIORITY_NAMES[level]}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.filter}>
        <span className="visually-hidden">Confidence</span>
        <select
          value={filters.confidence ?? ''}
          onChange={(event) => {
            const value = CONFIDENCE_BANDS.find((band) => band === event.target.value);
            onChange({ ...filters, confidence: value });
          }}
        >
          <option value="">Any confidence</option>
          {CONFIDENCE_BANDS.map((band) => (
            <option key={band} value={band}>
              {CONFIDENCE_NAMES[band]}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onChange({});
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
