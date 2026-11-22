/**
 * `npm run eval -- export-reviews`: writes stored reviews out as eval cases (see
 * `export-reviews.ts`), one fixture file per repository, in `.evals/exported/` (gitignored).
 *
 *   DATABASE_URL=postgres://... npm run eval -- export-reviews
 *   PGLITE_DATA_DIR=.data/pglite PRIORITY_LABELS='{"high":"P1"}' npm run eval -- export-reviews
 *   npm run eval -- --fixtures .evals/exported              # then evaluate on them
 *
 * Reads the database only; nothing calls GitHub or a model. Like the rest of the eval script it
 * doesn't load `.env`: set `DATABASE_URL` (or `PGLITE_DATA_DIR`) and `PRIORITY_LABELS` for the run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { PriorityLabels } from '@issue-triage/shared';

import { loadDatabaseConfig, priorityLabelsSchema } from '../src/config.js';
import { connectDatabase, type Database } from '../src/db/client.js';
import { EXPORT_BIAS_NOTE, exportReviewedCases } from './export-reviews.js';

export const DEFAULT_EXPORT_DIR = fileURLToPath(new URL('../.evals/exported/', import.meta.url));

export interface ExportDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** An open database, for tests. Otherwise one is opened from the environment. */
  db?: Database;
  log?: (line: string) => void;
}

export async function exportReviewsMain(
  argv: readonly string[],
  deps: ExportDeps,
): Promise<number> {
  const log =
    deps.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  let out: string;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { out: { type: 'string', default: DEFAULT_EXPORT_DIR } },
      strict: true,
    });
    out = values.out;
  } catch (error) {
    log(`eval export-reviews: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let priorityLabels: PriorityLabels = {};
  if (deps.env.PRIORITY_LABELS) {
    const parsed = priorityLabelsSchema.safeParse(deps.env.PRIORITY_LABELS);
    if (!parsed.success) {
      log('eval export-reviews: PRIORITY_LABELS must be a JSON object, like {"high":"P1"}');
      return 2;
    }
    priorityLabels = parsed.data;
  }

  const handle = deps.db ? null : await connectDatabase(loadDatabaseConfig({ ...deps.env }));
  try {
    const db = deps.db ?? handle?.db;
    if (!db) {
      return 2;
    }
    const { fixtures, skipped } = await exportReviewedCases(db, { priorityLabels });
    mkdirSync(out, { recursive: true });
    for (const fixture of fixtures) {
      const file = `${fixture.repository.replace('/', '__')}.json`;
      writeFileSync(join(out, file), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    const cases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
    log(
      `eval export-reviews: ${cases} cases from ${fixtures.length} repositories, ` +
        `${skipped.length} reviews skipped, in ${out}`,
    );
    log(`eval export-reviews: ${EXPORT_BIAS_NOTE}`);
    return 0;
  } finally {
    await handle?.close();
  }
}
