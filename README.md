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
- [ ] Review UI: keyboard-driven queue with accept, edit, and reject, and write-back to GitHub
- [ ] Evals and observability: suggestion quality metrics, OpenTelemetry, Grafana dashboard
- [ ] Auth and release: GitHub OAuth, rate limiting, security pass, Docker, docs, v0.1.0

## Layout

| Path              | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `apps/api`        | Fastify API, triage worker, Drizzle schema and SQL migrations  |
| `apps/web`        | React + Vite review UI (a shell page for now)                  |
| `packages/shared` | Domain types and Zod schemas shared by the API and the web app |

## Run locally

Requires Node 24 (see `.nvmrc`). No database setup is needed: without `DATABASE_URL`, the API
uses [PGlite](https://pglite.dev), an embedded Postgres, stored in `apps/api/.data/pglite`, and
applies migrations on startup.

```sh
npm ci
cp .env.example .env   # then set GITHUB_WEBHOOK_SECRET
npm run dev:api        # http://127.0.0.1:3000, with the triage worker
npm run dev:web        # http://localhost:5173
```

`.env.example` starts with `TRIAGE_PROVIDER=fake`, a deterministic stand-in model that needs no
API key. Set `TRIAGE_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to triage with Claude.

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

| Variable                    | Default           | Meaning                                             |
| --------------------------- | ----------------- | --------------------------------------------------- |
| `TRIAGE_PROVIDER`           | (required)        | `anthropic`, `bedrock`, or `fake`                   |
| `TRIAGE_MODEL`              | `claude-opus-5-5` | `anthropic.claude-opus-5-5` on Bedrock              |
| `TRIAGE_EFFORT`             | `medium`          | `low` to `max`: how much the model thinks           |
| `TRIAGE_MODEL_TIMEOUT_MS`   | `60000`           | Per model request; a job's deadline is 3x this      |
| `TRIAGE_WORKER_CONCURRENCY` | `1`               | Jobs at once in this process; `0` runs no worker    |
| `TRIAGE_MAX_ATTEMPTS`       | `5`               | Runs per job before it fails for good               |
| `GITHUB_TOKEN`              | (unset)           | Reads labels; optional for public repositories      |
| `ANTHROPIC_API_KEY`         | (unset)           | Read by the Anthropic SDK                           |
| `AWS_REGION`                | (unset)           | Required for Bedrock; credentials use the AWS chain |

Provider credentials are read by the SDKs from the environment and never pass through the
app's configuration. On the Anthropic API, requests opt into server-side refusal fallbacks, so a
benign issue that trips a safety classifier (a security bug report, say) is answered by a
fallback model rather than failing; the suggestion records which model answered.

### Running the worker

`npm run dev:api` (or `npm start -w @issue-triage/api` after a build) runs the worker inside the
API server, which is required with PGlite because the embedded database belongs to one process.
With Postgres, run workers separately and scale them independently, and set
`TRIAGE_WORKER_CONCURRENCY=0` on the API servers if they should not run jobs:

```sh
npm run dev:worker                    # or: npm run build && npm run worker -w @issue-triage/api
```

On `SIGTERM` or `SIGINT` a worker stops claiming jobs, gives running ones 10 seconds to finish,
then interrupts them and puts them back in the queue without using up an attempt.

To check credentials with one real model call (a few cents; no database or GitHub needed):

```sh
ANTHROPIC_API_KEY=... npm run smoke:triage
```

It does nothing without credentials, and it is not part of the test suite or CI.

## Tests and checks

```sh
npm test            # Vitest; each test file gets its own in-memory PGlite database
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

CI runs both: the full suite on PGlite, and migrations plus the API tests against a
`postgres:17` service container. The test that two workers never block on or share a job needs
two connections, so it runs only against Postgres. Tests never call a real model or GitHub: the
model is a fake or a stubbed SDK transport, and GitHub responses are mocked.

## How this was built

This project is built with AI coding agents (Claude Code) under my direction: I set the goals,
architecture, and priorities, and the agents write and test the code.

## License

[MIT](LICENSE)
