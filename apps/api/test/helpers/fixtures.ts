import { readFileSync } from 'node:fs';

/*
 * Hand-written webhook payloads for a fictional repository, `lumen-labs/lumen`. They follow the
 * shapes in GitHub's webhook documentation, trimmed to fields a real delivery carries.
 */

type IssuesFixtureName = 'issues.opened' | 'issues.edited' | 'issues.labeled' | 'issues.closed';
type FixtureName = IssuesFixtureName | 'issue_comment.created' | 'ping';

/** The parts of an `issues` payload that tests modify. */
export interface IssuesPayload {
  action: string;
  issue: {
    title: string;
    updated_at: string;
    [field: string]: unknown;
  };
  [field: string]: unknown;
}

function read(name: FixtureName): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/github/${name}.json`, import.meta.url), 'utf8'),
  );
}

/** A fresh copy of a payload fixture. */
export function payload(name: FixtureName): Record<string, unknown> {
  return read(name) as Record<string, unknown>;
}

/** A fresh copy of an `issues` event fixture, typed for modification. */
export function issuesPayload(name: IssuesFixtureName): IssuesPayload {
  return read(name) as IssuesPayload;
}
