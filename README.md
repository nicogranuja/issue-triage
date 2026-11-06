# issue-triage

[![CI](https://github.com/nicogranuja/issue-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/nicogranuja/issue-triage/actions/workflows/ci.yml)

AI-assisted GitHub issue triage with a human in the loop. A GitHub webhook stores issues in
Postgres. Claude suggests labels (from the repository's own label set), a priority, likely
duplicates, and a summary as structured output. A reviewer accepts, edits, or rejects each
suggestion in a fast, keyboard-driven React UI, and accepted changes are written back to GitHub.
An eval harness measures suggestion quality.

## Status: work in progress

- [x] Monorepo, CI, database schema and migrations, verified and idempotent webhook ingestion
- [x] Triage engine: Claude structured output, provider interface, Postgres job queue
- [x] Review UI: keyboard-driven queue with accept, edit, and reject, and write-back to GitHub
- [ ] Evals and observability: suggestion quality metrics, OpenTelemetry, Grafana dashboard
- [ ] Auth and release: GitHub OAuth, rate limiting, security pass, Docker, docs, v0.1.0

## Layout

| Path              | What it is                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `apps/api`        | Fastify API, review API, worker (triage and write-back), schema  |
| `apps/web`        | React + Vite + TanStack Query review UI, component and e2e tests |
| `packages/shared` | Domain types, the API contract (Zod), label-change planning      |

![The review queue, light theme](docs/queue-light.png)

<details>
<summary>More screenshots: dark theme, and editing a suggestion</summary>

![The review queue, dark theme](docs/queue-dark.png)
![Editing a suggestion before applying it, light theme](docs/detail-light.png)
![Editing a suggestion before applying it, dark theme](docs/detail-dark.png)

</details>

## Run locally

Requires Node 24 (see `.nvmrc`). One command runs everything, with no `.env`, GitHub, or API key:

```sh
npm ci
npm run dev        # API on http://127.0.0.1:3000, review UI on http://127.0.0.1:5173
```

That starts the API with the worker inside it, on [PGlite](https://pglite.dev) (an embedded
Postgres stored in `apps/api/.data/pglite`, migrated on startup), and the Vite dev server, which
proxies `/api` to it. Its defaults apply only to variables you haven't set: the fake model,
dry-run write-back (reviews are recorded, nothing is sent to GitHub), and demo data loaded into
an empty database: two fictional repositories with issues and suggestions written for this
project. `npm run seed` reloads the demo data (stop `npm run dev` first: PGlite belongs to one
process); deleting `apps/api/.data` starts over.

> [!WARNING]
> The review API has no authentication yet (GitHub sign-in is the last roadmap milestone).
> The server listens on `127.0.0.1` by default and warns if `HOST` is anything else. Don't
> expose it to a network. Until then, changes must be sent as JSON, which a cross-site form
> cannot do.

To run against your own repositories, copy `.env.example` to `.env`, set
`GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, and `WRITE_BACK_MODE=github`, and set
`TRIAGE_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` to triage with Claude.
`npm run dev:api` and `npm run dev:web` start the two halves separately.

To use a Postgres server instead, set `DATABASE_URL` in `.env` and apply migrations with
`npm run db:migrate -w @issue-triage/api`.

### Receiving webhooks

Create a repository webhook in GitHub that sends **Issues** events to `/webhooks/github` with
content type `application/json` and the same secret as `GITHUB_WEBHOOK_SECRET`. To reach a local
server, forward deliveries with a tunnel, or with the
[`gh webhook`](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing)
CLI extension.

Every delivery must carry a valid `X-Hub-Signature-256`. Each `X-GitHub-Delivery` id is
processed at most once; redeliveries are acknowledged without being applied again.

## Architecture

```mermaid
flowchart LR
  GH[GitHub] -- issues webhook --> WH[Webhook handler]
  WH -- issue + triage job,<br/>one transaction --> Q[(Postgres queue)]
  Q -- claim with SKIP LOCKED --> T[Triage job]
  T -- labels, priority,<br/>duplicates, summary --> S[(Pending suggestion)]
  S --> UI[Review UI]
  UI -- accept / edit / reject --> R[Review API]
  R -- review + write-back job,<br/>one transaction (outbox) --> Q
  Q -- after the undo window --> W[Write-back job]
  W -- re-read labels, then add / remove --> GH
```

1. **Webhook.** GitHub's `issues` events are verified (HMAC SHA-256), deduplicated by delivery
   id, and mirrored into Postgres. A new or edited issue gets a triage job in the same
   transaction.
2. **Queue.** One Postgres table holds every job, of two kinds: `triage` and `write_back`.
   Workers claim with `FOR UPDATE SKIP LOCKED`, under a lease with a fencing token, and retry
   failures with backoff.
3. **Triage.** The model suggests labels from the repository's own set, a priority, likely
   duplicates, and a summary; the answer is validated and stored as the issue's one pending
   suggestion.
4. **Review.** A person accepts, edits, or rejects it in the review UI.
5. **Outbox.** The review and the job that writes it back are inserted in one transaction, so
   an accepted decision can never be lost between the two.
6. **Write-back.** After a short undo window, a worker re-reads the repository's labels and the
   issue's labels from GitHub and applies the change.

## Review

The review UI lists pending suggestions for open issues, most urgent first, then oldest first,
with filters for repository, priority, and confidence. The selected suggestion shows its
summary, the label change as a diff against the issue's current labels (`+` added, `−`
removed, also announced in words), the priority and the label it will write, likely duplicates
with links, the model's one-line rationale for each, and its confidence, which stays quiet
unless it is low.

| Key        | Action                                                |
| ---------- | ----------------------------------------------------- |
| `j` / `↓`  | Next suggestion                                       |
| `k` / `↑`  | Previous suggestion                                   |
| `Enter`    | Open the suggestion (focus moves to it)               |
| `Esc`      | Close, or cancel editing                              |
| `a`        | Accept                                                |
| `e`        | Edit labels, priority, and a note, then `⌘↵` to apply |
| `r`        | Reject                                                |
| `u` / `⌘Z` | Undo the last review, until it is written             |
| `o`        | Open the issue on GitHub                              |
| `?`        | Show the shortcuts                                    |

Shortcuts never fire while typing in a field, and holding a key never reviews more than one
suggestion. Reviews are optimistic: the suggestion leaves the queue at once and focus moves to
the next one; if the API refuses or fails, it comes back where it was, with a message.

**Concurrency.** A review names the suggestion the reviewer saw. The API locks that row and
records the review only if it is still pending; otherwise it answers `409` with the reason
(already reviewed, superseded by a newer suggestion because the issue changed, or the issue was
closed) and the id of the newer suggestion, if any. The UI shows the reason and takes the
reviewer to it.

**Untrusted text.** Titles, bodies, summaries, rationales, and error messages can all contain
text chosen by whoever opened the issue, so they are rendered as plain text only: never as HTML
or markdown (lint forbids `dangerouslySetInnerHTML` and friends in the app). Links are rendered
only for `http(s)` URLs, and label colors are used only when they are hex.

| Endpoint                             | What it does                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `GET /api/queue`                     | `?repo=&priority=&confidence=&cursor=&limit=`, keyset-paged                |
| `GET /api/suggestions/:id`           | Issue, suggestion, duplicates, repository labels, review                   |
| `POST /api/suggestions/:id/review`   | `{decision: accept\|edit\|reject, labels?, baseLabels?, priority?, note?}` |
| `DELETE /api/suggestions/:id/review` | Undo, while the write-back has not started                                 |
| `GET /api/reviews`                   | Recent reviews and the state of their write-back                           |
| `GET /api/repositories`              | Repositories, with how many suggestions await review                       |

## Write-back to GitHub

A write-back job turns a review into label changes on the issue:

- **Labels are re-checked first.** GitHub creates any label you add that doesn't exist, so a
  label deleted since triage (or anything not in the repository's set) would quietly come back.
  The job fetches the repository's labels fresh (refreshing the 15-minute cache), applies only
  labels that still exist, in the repository's spelling, and records the rest as skipped.
- **Nothing is removed by accident.** The review stores a change (labels to add, labels to
  remove), worked out when the reviewer decided. Accepting only adds. A label is removed only
  if the reviewer saw it on the issue and unticked it in an edit (the edit says which labels it
  was based on, so one added on GitHub while the reviewer was editing is kept). Labels someone else changed on GitHub in the
  meantime are left alone.
- **Idempotent by construction.** The job is diff-based: it re-reads the issue's labels, adds
  the missing ones in one call, and deletes only removed labels the issue still has (a 404 from
  a concurrent removal counts as done). Running it twice changes nothing the second time, so a
  job whose worker crashed after calling GitHub is simply run again. A `PUT` of a computed final
  label set would be idempotent too, but it would also erase labels added on GitHub between the
  read and the write.
- **Retries.** Rate limits, 5xx, and timeouts retry with the queue's exponential backoff
  (honoring `Retry-After`). `401`, `403` (the token lacks Issues write access, or the repository
  is archived), `404` (the issue is gone or invisible to the token), and `422` (GitHub rejected
  the change) fail at once, with a message that says what to fix, shown in the Reviewed tab.
- **Priority.** GitHub issues have no priority field, so a priority is written as a label only
  when `PRIORITY_LABELS` maps it, for example `{"urgent":"P0","high":"P1"}`; an unmapped
  priority stays in this app. Setting a priority adds its label but does not remove another
  priority's label, since that would be a removal the reviewer didn't make; untick it in an
  edit instead.
- **Undo.** The job waits `WRITE_BACK_DELAY_MS` (10 seconds) before it is due. Until a worker
  claims it, undo deletes the review and its job and puts the suggestion back in the queue.

**Token permissions.** A fine-grained token with access to the repositories you triage, with
**Issues: read and write** and **Metadata: read** (always included). With
`WRITE_BACK_MODE=dry-run`, Issues read-only is enough. A classic token needs `public_repo`
(public repositories) or `repo`.

## Triage engine

When an issue is opened, edited, or reopened, the webhook handler stores it and queues a triage
job in the same transaction, so an issue is never saved without its job. A worker then:

1. Claims the job from the `triage_jobs` table with `FOR UPDATE SKIP LOCKED` and takes a lease.
2. Reads the repository's labels from the GitHub REST API (cached on the repository row for 15
   minutes) and picks the five most similar existing issues as duplicate candidates, using
   TF-IDF token overlap on titles and bodies (the trade-offs are explained in
   [`duplicates.ts`](apps/api/src/triage/duplicates.ts)).
3. Asks the model for labels, a priority, duplicates, and a summary, each judgement with a
   confidence and a one-sentence rationale. The request uses structured output, so the label
   field can only hold the repository's own labels.
4. Validates the answer with Zod: labels must be in the repository's set, duplicates among the
   candidates that were sent, values in range. Invalid output gets one corrective turn with the
   list of problems; if that fails too, the job fails.
5. Stores a pending suggestion with the model that answered, the prompt version, token usage,
   and latency, and replaces any unreviewed suggestion for the same issue.

Issue text is untrusted input to the model. The prompt JSON-encodes it (with `<` escaped, so it
cannot fake a tag boundary) and tells the model never to follow instructions inside it. The
model has no tools, and whatever it says is checked against the allowed labels and candidates
before it is stored; nothing is written to GitHub without a reviewer.

The job queue lives in Postgres rather than a broker so jobs commit atomically with the data
they describe, with one less service to run. Every run has a deadline that reaches the HTTP
calls, and the lease outlasts it; a crashed worker's jobs are claimed again when the lease
expires, and a fencing token keeps a late worker from overwriting the next one's result. Rate
limits, outages, and timeouts retry with exponential backoff and jitter (honoring `Retry-After`),
up to `TRIAGE_MAX_ATTEMPTS`; authentication, unknown-model, and invalid-output errors fail at
once. Deleted and transferred issues are marked removed and their jobs cancelled.

The prompt has a version (`PROMPT_VERSION` in [`prompt.ts`](apps/api/src/triage/prompt.ts))
stored on every suggestion, so prompt versions can be compared on the same issues. A test
fingerprints the prompt and fails if it changes without a version bump.

### Configuration

| Variable                    | Default           | Meaning                                                |
| --------------------------- | ----------------- | ------------------------------------------------------ |
| `TRIAGE_PROVIDER`           | (required)        | `anthropic`, `bedrock`, or `fake`                      |
| `TRIAGE_MODEL`              | `claude-opus-5-5` | `anthropic.claude-opus-5-5` on Bedrock                 |
| `TRIAGE_EFFORT`             | `medium`          | `low` to `max`: how much the model thinks              |
| `TRIAGE_MODEL_TIMEOUT_MS`   | `60000`           | Per model request; a job's deadline is 3x this         |
| `TRIAGE_WORKER_CONCURRENCY` | `1`               | Jobs at once in this process; `0` runs no worker       |
| `TRIAGE_MAX_ATTEMPTS`       | `5`               | Runs per job before it fails for good                  |
| `GITHUB_TOKEN`              | (unset)           | Reads labels, writes reviews back (see above)          |
| `WRITE_BACK_MODE`           | `github`          | `dry-run` records changes without calling GitHub       |
| `WRITE_BACK_DELAY_MS`       | `10000`           | Wait before writing a review back: the undo window     |
| `PRIORITY_LABELS`           | (unset)           | JSON map from priority to label; unmapped: not written |
| `SEED_DEMO_DATA`            | `false`           | Load demo data into an empty database at startup       |
| `ANTHROPIC_API_KEY`         | (unset)           | Read by the Anthropic SDK                              |
| `AWS_REGION`                | (unset)           | Required for Bedrock; credentials use the AWS chain    |

Provider credentials are read by the SDKs from the environment and never pass through the
app's configuration. On the Anthropic API, requests opt into server-side refusal fallbacks, so a
benign issue that trips a safety classifier (a security bug report, say) is answered by a
fallback model rather than failing; the suggestion records which model answered.

### Running the worker

The worker runs both kinds of job, triage and write-back. `npm run dev:api` (or
`npm start -w @issue-triage/api` after a build) runs it inside the API server, which is required with PGlite because the embedded database belongs to one process.
With Postgres, run workers separately and scale them independently, and set
`TRIAGE_WORKER_CONCURRENCY=0` on the API servers if they should not run jobs:

```sh
npm run dev:worker                    # or: npm run build && npm run worker -w @issue-triage/api
```

On `SIGTERM` or `SIGINT` a worker stops claiming jobs, gives running ones 5 seconds to finish,
then interrupts them and puts them back in the queue without using up an attempt. That fits
within the 10 seconds container runtimes usually allow before `SIGKILL`; a worker killed outright
loses nothing either, since its jobs are claimed again when their leases expire.

To check credentials with one real model call (a few cents; no database or GitHub needed):

```sh
ANTHROPIC_API_KEY=... npm run smoke:triage
```

It does nothing without credentials, and it is not part of the test suite or CI.

## Tests and checks

```sh
npm test            # Vitest: API tests (each file on its own in-memory PGlite), component tests
npm run e2e -w @issue-triage/web   # Playwright: seed, accept with `a`, check the write-back
npm run lint        # ESLint with type-aware rules
npm run format      # Prettier (format:check in CI)
npm run typecheck
npm run build
```

To run the API tests against a real Postgres server, set `DATABASE_URL` to a role that can
create databases. Each test file then runs in a throwaway database that is dropped afterwards:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -w @issue-triage/api
```

Component tests render the whole app with Testing Library on jsdom against an in-memory fake of
the API: keyboard shortcuts (and that they stay quiet in fields), optimistic updates and their
rollback, and plain-text rendering of an issue titled `<img src=x onerror=alert(1)>`. The
Playwright test starts the real API (fake model, in-memory PGlite with the demo data, dry-run
write-back) and the dev server; locally it uses the installed Google Chrome, and CI installs
Playwright's Chromium. `npm run screenshots -w @issue-triage/web` regenerates the images in
`docs/`.

CI runs the full suite on PGlite, migrations plus the API tests against a `postgres:17` service
container, and the Playwright test. The test that two workers never block on or share a job needs
two connections, so it runs only against Postgres. Tests never call a real model or GitHub: the
model is a fake or a stubbed SDK transport, and GitHub is an in-memory fake that, like GitHub,
creates unknown labels on the fly, so a test fails if the write-back ever sends one.

## How this was built

This project is built with AI coding agents (Claude Code) under my direction: I set the goals,
architecture, and priorities, and the agents write and test the code.

## License

[MIT](LICENSE)
