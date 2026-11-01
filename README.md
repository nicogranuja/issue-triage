# issue-triage

[![CI](https://github.com/nicogranuja/issue-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/nicogranuja/issue-triage/actions/workflows/ci.yml)

AI-assisted GitHub issue triage with a human in the loop. A GitHub webhook stores issues in
Postgres. Claude suggests labels (from the repository's own label set), a priority, likely
duplicates, and a summary as structured output. A reviewer accepts, edits, or rejects each
suggestion in a fast, keyboard-driven React UI, and accepted changes are written back to GitHub.
An eval harness measures suggestion quality.

## Status: work in progress

- [x] Monorepo, CI, database schema and migrations, verified and idempotent webhook ingestion
- [ ] Triage engine: Claude structured output, provider interface, Postgres job queue
- [ ] Review UI: keyboard-driven queue with accept, edit, and reject, and write-back to GitHub
- [ ] Evals and observability: suggestion quality metrics, OpenTelemetry, Grafana dashboard
- [ ] Auth and release: GitHub OAuth, rate limiting, security pass, Docker, docs, v0.1.0

## Layout

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `apps/api`        | Fastify API: webhook ingestion, Drizzle schema and SQL migrations |
| `apps/web`        | React + Vite review UI (a shell page for now)                     |
| `packages/shared` | Domain types and Zod schemas shared by the API and the web app    |

## Run locally

Requires Node 24 (see `.nvmrc`). No database setup is needed: without `DATABASE_URL`, the API
uses [PGlite](https://pglite.dev), an embedded Postgres, stored in `apps/api/.data/pglite`, and
applies migrations on startup.

```sh
npm ci
cp .env.example .env   # then set GITHUB_WEBHOOK_SECRET
npm run dev:api        # http://127.0.0.1:3000
npm run dev:web        # http://localhost:5173
```

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
`postgres:17` service container.

## How this was built

This project is built with AI coding agents (Claude Code) under my direction: I set the goals,
architecture, and priorities, and the agents write and test the code.

## License

[MIT](LICENSE)
