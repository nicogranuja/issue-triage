import type { QueueFilters, QueueItem, Review, ReviewRequest } from '@issue-triage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './App.module.css';
import type { ApiError } from './api/client.ts';
import {
  prefetchSuggestion,
  useQueue,
  useRecentReviews,
  useReviewMutation,
  useSuggestion,
  useUndoMutation,
} from './api/queries.ts';
import { Filters } from './components/Filters.tsx';
import { HelpDialog } from './components/HelpDialog.tsx';
import { QueueList, QueueSkeleton } from './components/QueueList.tsx';
import { ReviewedList } from './components/ReviewedList.tsx';
import { DetailSkeleton, SuggestionDetail } from './components/SuggestionDetail.tsx';
import { useToasts } from './components/Toasts.tsx';
import { useShortcuts, type Shortcut } from './hooks/useShortcuts.ts';
import { useTheme } from './hooks/useTheme.ts';
import { safeHttpUrl } from './lib/safe.ts';
import { readUrlState, writeUrlState, type View } from './lib/url-state.ts';

/** The most recent review, which `u` can take back until its write-back starts. */
interface LastReview {
  suggestionId: number;
  /** Client clock time after which undo is no longer offered. */
  until: number;
}

interface FocusRequest {
  target: 'row' | 'heading';
  /** Increments with each request, so asking twice for the same target still moves focus. */
  tick: number;
}

/** How long a rejection (which writes nothing) stays undoable from the keyboard. */
const REJECT_UNDO_MS = 10_000;

const PAST_TENSE: Record<Review['decision'], string> = {
  accepted: 'Accepted',
  edited: 'Applied your edit to',
  rejected: 'Rejected',
};

/** A focused control that handles Enter (and arrows) itself. */
function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('a, button, summary, [role="button"]') !== null
  );
}

function inQueueList(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-queue-list]') !== null;
}

export function App() {
  const initial = useMemo(() => readUrlState(), []);
  const [filters, setFilters] = useState<QueueFilters>(initial.filters);
  const [view, setView] = useState<View>(initial.view);
  const [selectedId, setSelectedId] = useState<number | null>(initial.selected);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [lastReview, setLastReview] = useState<LastReview | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const { theme, cycle: cycleTheme } = useTheme();
  const toasts = useToasts();
  const client = useQueryClient();

  const queue = useQueue(filters);
  const items = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const total = queue.data?.pages.at(-1)?.total ?? 0;
  const shownId = selectedId ?? items[0]?.suggestionId ?? null;
  const shownIndex = items.findIndex((item) => item.suggestionId === shownId);
  const shownItem = shownIndex === -1 ? undefined : items[shownIndex];
  const detail = useSuggestion(view === 'queue' ? shownId : null);
  const reviews = useRecentReviews({ enabled: view === 'reviewed' });

  // Focus follows the selection when the keyboard moved it. It is applied after render, once the
  // row (or heading) that should receive it exists; a row that hasn't loaded yet gets it later.
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const handledFocus = useRef(0);
  const registerRow = useCallback((id: number, element: HTMLButtonElement | null) => {
    if (element) {
      rows.current.set(id, element);
    } else {
      rows.current.delete(id);
    }
  }, []);
  const requestFocus = (target: FocusRequest['target']) => {
    setFocusRequest((previous) => ({ target, tick: (previous?.tick ?? 0) + 1 }));
  };
  useEffect(() => {
    if (!focusRequest || focusRequest.tick === handledFocus.current) {
      return;
    }
    const element =
      focusRequest.target === 'heading'
        ? heading.current
        : shownId === null
          ? null
          : rows.current.get(shownId);
    if (element) {
      element.focus();
      handledFocus.current = focusRequest.tick;
    }
  }, [focusRequest, shownId, items, detail.data]);

  useEffect(() => {
    writeUrlState({ filters, view, selected: selectedId });
  }, [filters, view, selectedId]);

  useEffect(() => {
    document.title = total > 0 ? `(${total}) Issue Triage` : 'Issue Triage';
  }, [total]);

  // Load the neighbours too, so j/k show them without a loading state.
  useEffect(() => {
    for (const neighbour of [items[shownIndex + 1], items[shownIndex - 1]]) {
      if (neighbour) {
        prefetchSuggestion(client, neighbour.suggestionId);
      }
    }
  }, [client, items, shownIndex]);

  // Nearing the end of what is loaded fetches the next page.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = queue;
  useEffect(() => {
    if (shownIndex >= items.length - 3 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [shownIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const select = (id: number | null, focus?: 'row') => {
    setSelectedId(id);
    setEditing(false);
    if (focus) {
      requestFocus(focus);
    }
  };

  const undo = useUndoMutation({
    onSuccess: (suggestionId) => {
      setView('queue');
      select(suggestionId, 'row');
      toasts.show({ message: 'Undone. The suggestion is back in the queue.' });
    },
    onError: (error) => {
      toasts.show({ message: `Couldn’t undo: ${error.message}`, tone: 'error' });
    },
  });

  const undoSuggestion = (suggestionId: number) => {
    if (!undo.isPending) {
      undo.mutate(suggestionId);
      setLastReview(null);
    }
  };
  const undoLast = () => {
    if (lastReview && Date.now() < lastReview.until) {
      undoSuggestion(lastReview.suggestionId);
    }
  };

  const review = useReviewMutation({
    onSuccess: (saved, { item }) => {
      // The server has the last word; stop offering undo a second before the job is due.
      const until = saved.writeBack
        ? Date.parse(saved.writeBack.runAfter) - 1_000
        : Date.now() + REJECT_UNDO_MS;
      const undoable = saved.writeBack !== null || saved.decision === 'rejected';
      setLastReview(undoable ? { suggestionId: item.suggestionId, until } : null);
      const nothingToWrite =
        saved.writeBack === null && saved.decision !== 'rejected'
          ? ' Its labels were already up to date.'
          : '';
      toasts.show({
        message: `${PAST_TENSE[saved.decision]} #${item.issue.number}.${nothingToWrite}`,
        ...(undoable && {
          action: {
            label: 'Undo',
            shortcut: 'U',
            run: () => {
              undoSuggestion(item.suggestionId);
            },
          },
          durationMs: Math.max(2_000, Math.min(8_000, until - Date.now())),
        }),
      });
    },
    onError: (error: ApiError, variables) => {
      const { item } = variables;
      if (error.conflict) {
        // Show why: the newer suggestion, or this one with its "can't review" note.
        select(error.conflict.currentSuggestionId ?? item.suggestionId, 'row');
        toasts.show({ message: `#${item.issue.number}: ${error.message}`, tone: 'error' });
        return;
      }
      toasts.show({
        message: `Couldn’t save the review of #${item.issue.number}: ${error.message} It’s back in the queue.`,
        tone: 'error',
        action: {
          label: 'Retry',
          run: () => {
            review.mutate(variables);
          },
        },
      });
    },
  });

  const reviewable =
    shownItem !== undefined &&
    detail.data?.id === shownItem.suggestionId &&
    detail.data.status === 'pending' &&
    detail.data.issue.state === 'open' &&
    !detail.data.issue.removed;

  const submit = (item: QueueItem, request: ReviewRequest) => {
    // Move on at once: to the next row, or the previous one at the end of the list.
    const index = items.indexOf(item);
    const next = items[index + 1] ?? items[index - 1] ?? null;
    select(next?.suggestionId ?? null, 'row');
    review.mutate({ item, request });
  };

  const decide = (decision: 'accept' | 'reject') => {
    if (shownItem && reviewable) {
      submit(shownItem, { decision });
    }
  };

  const startEditing = () => {
    if (reviewable) {
      setOpen(true);
      setEditing(true);
    }
  };

  const move = (step: 1 | -1) => {
    if (items.length === 0) {
      return;
    }
    const from = shownIndex === -1 ? (step === 1 ? -1 : items.length) : shownIndex;
    const target = items[Math.min(items.length - 1, Math.max(0, from + step))];
    if (target) {
      select(target.suggestionId, 'row');
    }
  };

  const openDetail = () => {
    if (shownId !== null) {
      setOpen(true);
      requestFocus('heading');
    }
  };

  const close = () => {
    if (editing) {
      setEditing(false);
    } else if (open) {
      setOpen(false);
    } else {
      return;
    }
    requestFocus('row');
  };

  const queueKeys = view === 'queue' && !helpOpen && !editing;
  const shortcuts: Shortcut[] = [
    {
      key: '?',
      run: () => {
        setHelpOpen((value) => !value);
      },
    },
  ];
  if (queueKeys) {
    // Arrows only act on the list when focus is in it (or nowhere in particular), so they
    // still work as usual on other focused controls.
    const arrowsApply = (event: KeyboardEvent) =>
      inQueueList(event.target) || !isInteractive(event.target);
    shortcuts.push(
      {
        key: 'j',
        repeat: true,
        run: () => {
          move(1);
        },
      },
      {
        key: 'k',
        repeat: true,
        run: () => {
          move(-1);
        },
      },
      {
        key: 'ArrowDown',
        repeat: true,
        when: arrowsApply,
        run: () => {
          move(1);
        },
      },
      {
        key: 'ArrowUp',
        repeat: true,
        when: arrowsApply,
        run: () => {
          move(-1);
        },
      },
      // On a focused button or link, Enter activates it instead.
      { key: 'Enter', when: (event) => !isInteractive(event.target), run: openDetail },
      {
        key: 'a',
        run: () => {
          decide('accept');
        },
      },
      {
        key: 'r',
        run: () => {
          decide('reject');
        },
      },
      { key: 'e', run: startEditing },
      {
        key: 'o',
        run: () => {
          const url = shownItem && safeHttpUrl(shownItem.issue.htmlUrl);
          if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        },
      },
    );
  }
  if (view === 'queue' && !helpOpen) {
    shortcuts.push({ key: 'Escape', run: close });
  }
  if (!helpOpen && !editing) {
    shortcuts.push({ key: 'u', run: undoLast }, { key: 'z', withMod: true, run: undoLast });
  }
  useShortcuts(shortcuts);

  const filtered = Boolean(filters.repo ?? filters.priority ?? filters.confidence);
  const changeFilters = (next: QueueFilters) => {
    setFilters(next);
    select(null);
  };

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <h1 className={styles.brand}>
          <span className={styles.logo} aria-hidden="true" />
          Issue Triage
        </h1>
        <nav className={styles.views} aria-label="Views">
          <button
            type="button"
            aria-current={view === 'queue' ? 'page' : undefined}
            onClick={() => {
              setView('queue');
            }}
          >
            To review <span className={styles.count}>{queue.isSuccess ? total : '–'}</span>
          </button>
          <button
            type="button"
            aria-current={view === 'reviewed' ? 'page' : undefined}
            onClick={() => {
              setView('reviewed');
              setEditing(false);
            }}
          >
            Reviewed
          </button>
        </nav>
        {view === 'queue' && <Filters filters={filters} onChange={changeFilters} />}
        <div className={styles.tools}>
          <button
            type="button"
            className={styles.tool}
            onClick={cycleTheme}
            aria-label={`Theme: ${theme}. Change theme`}
            title={`Theme: ${theme}`}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</span>
          </button>
          <button
            type="button"
            className={styles.tool}
            onClick={() => {
              setHelpOpen(true);
            }}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <span aria-hidden="true">?</span>
          </button>
        </div>
      </header>

      {view === 'reviewed' ? (
        <main className={styles.single}>
          <h2 className="visually-hidden">Recent reviews</h2>
          {reviews.isPending ? (
            <QueueSkeleton />
          ) : reviews.isError ? (
            <ErrorState message={reviews.error.message} onRetry={() => void reviews.refetch()} />
          ) : (
            <ReviewedList
              items={reviews.data.items}
              undoing={undo.isPending}
              onUndo={undoSuggestion}
            />
          )}
        </main>
      ) : (
        <main className={styles.main} data-open={open || undefined}>
          <section
            className={styles.listPane}
            aria-labelledby="queue-title"
            aria-busy={queue.isPending}
            data-queue-list
          >
            <h2 id="queue-title" className="visually-hidden">
              Queue
            </h2>
            {queue.isPending ? (
              <>
                <p className="visually-hidden" role="status">
                  Loading suggestions…
                </p>
                <QueueSkeleton />
              </>
            ) : queue.isError ? (
              <ErrorState message={queue.error.message} onRetry={() => void queue.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                filtered={filtered}
                onClear={() => {
                  changeFilters({});
                }}
              />
            ) : (
              <QueueList
                items={items}
                selectedId={shownId}
                onSelect={(id) => {
                  if (id !== shownId) {
                    select(id);
                  }
                }}
                onOpen={() => {
                  setOpen(true);
                }}
                registerItem={registerRow}
                hasMore={queue.hasNextPage}
                loadingMore={queue.isFetchingNextPage}
                onLoadMore={() => void queue.fetchNextPage()}
              />
            )}
          </section>

          <section className={styles.detailPane} aria-label="Suggestion">
            {open && (
              <button type="button" className={styles.back} onClick={close}>
                ← Queue <kbd aria-hidden="true">Esc</kbd>
              </button>
            )}
            {shownId === null ? null : detail.isPending ? (
              <DetailSkeleton />
            ) : detail.isError ? (
              <ErrorState
                message={
                  detail.error.status === 404
                    ? 'This suggestion doesn’t exist any more.'
                    : detail.error.message
                }
                onRetry={() => void detail.refetch()}
              />
            ) : (
              <SuggestionDetail
                detail={detail.data}
                editing={editing}
                submitting={review.isPending}
                headingRef={heading}
                onAccept={() => {
                  decide('accept');
                }}
                onReject={() => {
                  decide('reject');
                }}
                onEdit={startEditing}
                onCancelEdit={close}
                onSubmitEdit={(request) => {
                  if (shownItem && reviewable) {
                    submit(shownItem, request);
                  }
                }}
                onShowSuggestion={(id) => {
                  select(id, 'row');
                }}
              />
            )}
          </section>
        </main>
      )}

      <HelpDialog
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
        }}
      />
    </div>
  );
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className={styles.state} role="status">
      <p className={styles.stateTitle}>
        {filtered ? 'Nothing matches these filters' : 'All caught up'}
      </p>
      <p className={styles.stateText}>
        {filtered
          ? 'Other suggestions are waiting outside them.'
          : 'New issues appear here once they have been triaged.'}
      </p>
      {filtered && (
        <button type="button" className={styles.stateButton} onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.state} role="alert">
      <p className={styles.stateTitle}>Something went wrong</p>
      <p className={styles.stateText}>{message}</p>
      <button type="button" className={styles.stateButton} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
