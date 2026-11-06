import {
  confidenceBand,
  labelKey,
  planLabelChange,
  type ReviewRequest,
  type SuggestionDetail as Detail,
} from '@issue-triage/shared';
import { useMemo, type ReactNode, type Ref } from 'react';

import { percent, PRIORITY_NAMES, timeAgo } from '../lib/format.ts';
import { safeHttpUrl } from '../lib/safe.ts';
import { EditForm } from './EditForm.tsx';
import { LabelDiff } from './Labels.tsx';
import { PriorityBadge } from './Priority.tsx';
import styles from './SuggestionDetail.module.css';

export interface SuggestionDetailProps {
  detail: Detail;
  editing: boolean;
  submitting: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
  onSubmitEdit: (request: ReviewRequest) => void;
  onCancelEdit: () => void;
  onShowSuggestion: (id: number) => void;
}

/** A link that only renders as one for an http(s) URL; anything else stays plain text. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHttpUrl(href);
  if (!safe) {
    return <span>{children}</span>;
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** The model's confidence, deliberately quiet; spelled out when it is low. */
function Confidence({ value }: { value: number }) {
  const low = confidenceBand(value) === 'low';
  return (
    <span className={styles.confidence} data-low={low || undefined} title="Model confidence">
      {low ? `Low confidence · ${percent(value)}` : percent(value)}
      <span className="visually-hidden"> confidence</span>
    </span>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** Why this suggestion can't be reviewed as it is, if it can't. */
function staleReason(detail: Detail): string | null {
  if (detail.issue.removed) {
    return 'This issue was deleted or transferred on GitHub.';
  }
  if (detail.issue.state !== 'open') {
    return 'This issue was closed on GitHub, so it no longer needs triage.';
  }
  if (detail.status === 'reviewed') {
    return 'This suggestion was already reviewed.';
  }
  if (detail.status === 'superseded') {
    return 'This suggestion is out of date: the issue changed and was triaged again.';
  }
  return null;
}

export function SuggestionDetail(props: SuggestionDetailProps) {
  const { detail, editing, submitting, headingRef } = props;
  const colors = useMemo(
    () => new Map(detail.repository.labels?.map((label) => [labelKey(label.name), label.color])),
    [detail.repository.labels],
  );
  // Suggested labels the repository has deleted since triage: the write-back will skip them.
  const missing = useMemo(() => {
    const defined = detail.repository.labels?.map((label) => labelKey(label.name));
    return defined
      ? new Set(detail.labels.names.map(labelKey).filter((key) => !defined.includes(key)))
      : new Set<string>();
  }, [detail]);

  const priorityLabel = detail.priorityLabels[detail.priority.level];
  const change = planLabelChange({
    current: detail.issue.labels,
    target: detail.labels.names,
    removeUnlisted: false,
    priorityLabel,
  });
  const stale = staleReason(detail);
  const issueUrl = detail.issue.htmlUrl;

  return (
    <article className={styles.detail} aria-labelledby="detail-title">
      <header className={styles.header}>
        <p className={styles.meta}>
          <span>{detail.repository.fullName}</span>
          <span aria-hidden="true">·</span>
          <ExternalLink href={issueUrl}>#{detail.issue.number} on GitHub</ExternalLink>
          <span aria-hidden="true">·</span>
          <span>
            opened {timeAgo(detail.issue.githubCreatedAt)}
            {detail.issue.authorLogin && <> by {detail.issue.authorLogin}</>}
          </span>
        </p>
        <h2 id="detail-title" className={styles.title} ref={headingRef} tabIndex={-1}>
          {detail.issue.title}
        </h2>
      </header>

      {stale && (
        <div className={styles.stale} role="status">
          <p>
            <strong>Can’t review this one.</strong> {stale}
          </p>
          {detail.newerSuggestionId !== null && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                if (detail.newerSuggestionId !== null) {
                  props.onShowSuggestion(detail.newerSuggestionId);
                }
              }}
            >
              Show the new suggestion
            </button>
          )}
        </div>
      )}

      {editing && !stale ? (
        <EditForm
          detail={detail}
          colors={colors}
          missing={missing}
          submitting={submitting}
          onSubmit={props.onSubmitEdit}
          onCancel={props.onCancelEdit}
        />
      ) : (
        <>
          <Section title="Summary">
            <p className={styles.summary}>{detail.summary}</p>
          </Section>

          <Section title="Labels" aside={<Confidence value={detail.labels.confidence} />}>
            <LabelDiff
              change={change}
              colors={colors}
              missing={missing}
              priorityLabel={priorityLabel}
              label="Labels after accepting"
            />
            <p className={styles.rationale}>{detail.labels.rationale}</p>
          </Section>

          <Section title="Priority" aside={<Confidence value={detail.priority.confidence} />}>
            <p className={styles.priority}>
              <PriorityBadge priority={detail.priority.level} />
              <span className={styles.priorityNote}>
                {priorityLabel
                  ? `Written to GitHub as “${priorityLabel}”`
                  : `Kept here only: no label is mapped to ${PRIORITY_NAMES[detail.priority.level].toLowerCase()}`}
              </span>
            </p>
            <p className={styles.rationale}>{detail.priority.rationale}</p>
          </Section>

          <Section
            title="Possible duplicates"
            aside={<Confidence value={detail.duplicates.confidence} />}
          >
            {detail.duplicates.issues.length === 0 ? (
              <p className={styles.muted}>None found.</p>
            ) : (
              <ul className={styles.duplicates}>
                {detail.duplicates.issues.map((duplicate) => (
                  <li key={duplicate.issueId}>
                    <ExternalLink href={duplicate.htmlUrl}>
                      #{duplicate.number} {duplicate.title}
                    </ExternalLink>
                    <span className={styles.state} data-state={duplicate.state}>
                      {duplicate.state === 'open' ? 'Open' : 'Closed'}
                    </span>
                    <p className={styles.reason}>{duplicate.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.rationale}>{detail.duplicates.rationale}</p>
          </Section>

          {detail.issue.body && (
            <details className={styles.body}>
              <summary>Issue description</summary>
              {/* Plain text, never markdown or HTML: it is whatever the issue author wrote. */}
              <div className={styles.bodyText}>{detail.issue.body}</div>
            </details>
          )}
        </>
      )}

      {!editing && !stale && (
        <footer className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={props.onAccept}
            disabled={submitting}
          >
            Accept <kbd aria-hidden="true">A</kbd>
          </button>
          <button type="button" className={styles.secondary} onClick={props.onEdit}>
            Edit <kbd aria-hidden="true">E</kbd>
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={props.onReject}
            disabled={submitting}
          >
            Reject <kbd aria-hidden="true">R</kbd>
          </button>
          <span className={styles.model}>
            {detail.model} · {detail.promptVersion}
          </span>
        </footer>
      )}
    </article>
  );
}

export function DetailSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      <span style={{ inlineSize: '30%' }} />
      <span style={{ inlineSize: '75%', blockSize: '1.25rem' }} />
      <span style={{ inlineSize: '90%' }} />
      <span style={{ inlineSize: '60%' }} />
    </div>
  );
}
