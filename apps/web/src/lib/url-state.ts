import { CONFIDENCE_BANDS, PRIORITIES, type QueueFilters } from '@issue-triage/shared';

export type View = 'queue' | 'reviewed';

export interface UrlState {
  filters: QueueFilters;
  view: View;
  /** The selected suggestion. */
  selected: number | null;
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return (values as readonly (string | null)[]).includes(value) ? (value as T) : undefined;
}

/** Reads the view state from the address bar, ignoring anything malformed. */
export function readUrlState(search: string = window.location.search): UrlState {
  const params = new URLSearchParams(search);
  const repo = params.get('repo');
  const selected = Number(params.get('s'));
  return {
    filters: {
      repo: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined,
      priority: oneOf(PRIORITIES, params.get('priority')),
      confidence: oneOf(CONFIDENCE_BANDS, params.get('confidence')),
    },
    view: params.get('view') === 'reviewed' ? 'reviewed' : 'queue',
    selected: Number.isSafeInteger(selected) && selected > 0 ? selected : null,
  };
}

/** Mirrors the view state into the address bar, so a reload or a shared link keeps it. */
export function writeUrlState({ filters, view, selected }: UrlState): void {
  const params = new URLSearchParams();
  if (filters.repo) {
    params.set('repo', filters.repo);
  }
  if (filters.priority) {
    params.set('priority', filters.priority);
  }
  if (filters.confidence) {
    params.set('confidence', filters.confidence);
  }
  if (view === 'reviewed') {
    params.set('view', view);
  }
  if (selected !== null && view === 'queue') {
    params.set('s', String(selected));
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  if (url !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, '', url);
  }
}
