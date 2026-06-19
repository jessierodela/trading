# P8 Operational Validation

Branch: `ai/p8-operational-validation`

Commit: based on `43b08b72bdf58cb7fe17f816bc55e63a8eefd356`; the validation artifact commit is recorded in Git history.

Date: 2026-06-19

Environment: local Windows/Next.js process with a hosted Postgres connection loaded from `.env.local`

DB target: unknown (hosted Supabase; not confirmed disposable, staging, or production)

Secrets printed: no

Environment presence:

```text
SUPABASE_DB_URL present: yes
DATABASE_URL present: no
SCHEDULER_SECRET present: no
```

## Commands Run

- `npm.cmd exec -- tsc --noEmit --pretty false`
  - PASS
  - No TypeScript errors.
- `npm.cmd run migrate:status`
  - PASS
  - No pending migrations; three migrations are recorded as applied.
- `npm.cmd run smoke:jobs`
  - PASS for runtime payload validation.
  - The DB lifecycle section skipped because this package script does not load `.env.local` and the destructive gate was not enabled.
- `npm.cmd run smoke:pipeline-services`
  - PASS
- `npm.cmd run smoke:job-worker`
  - PASS
- `npm.cmd run smoke:route-jobs`
  - PASS
- `npm.cmd run smoke:scheduler-bootstrap`
  - PASS
- `npm.cmd run smoke:strategies`
  - PASS, 138 checks.
- `npm.cmd run smoke:backtest`
  - PASS, 112 checks.
- `npm.cmd run smoke:paper-trading`
  - PASS, 35 checks.
- `npm.cmd run scheduler:feed -- --once --dry-run`
  - PASS
  - Planned six stages for closed bar `2026-06-19T15:00:00.000Z` without a DB write.
- `npm.cmd run scheduler:feed -- --once`
  - PASS
  - Reused the existing feed: one succeeded stage was skipped and five active stages were deduped.
- `npm.cmd run worker:jobs -- --once`
  - PARTIAL at the command-wrapper level: the shell command timed out after 124 seconds.
  - PASS at the persisted job level: the claimed `features.compute` job completed after approximately 169 seconds with status `succeeded`, one attempt, and 1,500 feature rows computed across five symbols.
- `npm.cmd run validate:p8:operational`
  - PASS
  - All 43 non-destructive schema, runtime safety, queue, snapshot-read, and scheduler checks passed.
- `npm.cmd run dev -- --port 3000`
  - PASS for local route validation; stopped after testing.
- `npm.cmd run build`
  - PASS
  - Existing React Hook dependency warning remains in `components/layout/SignalsPanel.tsx`.
- `REQUIRE_DB_SMOKE=1 SMOKE_ALLOW_TRUNCATE=1 npm.cmd run smoke:jobs`
  - SKIPPED during this validation task because the configured DB is not confirmed disposable.

## Migration Status

PASS.

The migration runner reported:

```text
No pending migrations. 3 applied.
```

Required P8 tables, indexes, and named queue constraints were present. No migration drift was reported. No migration or repair was applied from this branch.

## DB Validation

PASS for non-destructive operational checks.

- Required tables exist: `jobs`, `job_events`, `dashboard_snapshots`, `market_bars`, `feature_snapshots`, `regime_snapshots`, and `strategy_signals`.
- Required queue/snapshot indexes exist.
- Required job status, type, payload, attempts, max-attempts, and priority constraints exist.
- Runtime and DB job type allowlists contain the seven P8 job types and exclude all forbidden live-execution types.
- A uniquely keyed, future-dated validation `dashboard.snapshot` job was enqueued, fetched by public ID, found in the active listing, and cancelled cleanly.
- Fetching the latest non-expired dashboard snapshot completed without crashing.
- The fixed scheduler dry run left the total job count unchanged.

The destructive DB lifecycle smoke was not rerun because the target classification is unknown. Earlier operator-authorized testing against the same configured DB exercised the lifecycle and constraints but reported two order-sensitive JSON metadata comparison failures even though the values matched.

## Scheduler Validation

PASS.

- Feed name was `non-stop scheduled feed`.
- Six paper-pipeline stages were planned.
- The CLI selected the latest closed 1-hour bar.
- Every dedupe key contained the closed-bar timestamp.
- Dry-run performed no DB mutation.
- The real scheduler run executed no handlers and created no live-execution jobs.
- The repeated real run returned one `skipped_succeeded` action and five `deduped` actions, confirming idempotency.

## Worker Validation

PASS for one real job, PARTIAL for continuous hosting.

- A one-shot worker claimed the scheduled `features.compute` job.
- The job ran longer than the default 60-second lease and still completed successfully, which operationally confirms heartbeat lease extension.
- Completion was persisted with one attempt, no error, and 1,500 computed feature rows.
- Worker smokes confirmed completion, retryable/non-retryable failure handling, heartbeat start/stop, lifecycle events, and route-free handler boundaries.
- No `--loop` worker was hosted during this validation.
- Operational hosting should run `npm.cmd run worker:jobs -- --loop` under a process supervisor with graceful shutdown and a command timeout longer than the slowest stage.

## Route Validation

Local route checks ran against `http://127.0.0.1:3000`:

- `POST /api/cache/refresh`: PASS, `202`, queued `dashboard.snapshot`.
- `POST /api/regime/refresh?symbol=BTC`: PASS, `202`, queued `regime.compute` for `BTC-USD`.
- `GET /api/jobs/status?active=1&limit=10`: PASS, `200`, public job status objects returned.
- `GET /api/signals`: PASS for clean empty-state behavior, `200`; no generated dashboard snapshot was available yet.
- `GET /api/regime/BTC`: PASS, `200`; persisted `LOW_VOL` state returned with timestamp.
- `GET /api/jobs/schedule`: PASS, `401` without scheduler credentials.
- `GET /api/jobs/schedule?dryRun=1`: PASS, `200`, protected by `local_dry_run`, six jobs planned.

Browser verification passed: the home page returned `200`, rendered meaningful content, showed no framework error overlay, and a reload produced no 4xx/5xx resource responses. The local server and browser were stopped after validation.

## Vercel/Cron Validation

- PASS: `vercel.json` contains `/api/jobs/schedule` with schedule `5 * * * *`.
- PASS: scheduler authorization behavior is covered by smoke tests and local route checks.
- NOT TESTED: deployed Vercel environment-variable presence.
- NOT TESTED: a real Vercel Cron invocation.
- NOT TESTED: a permanently hosted worker process.

`SCHEDULER_SECRET` is absent locally. Production must either configure it for protected manual calls or rely on the verified Vercel Cron user-agent path.

## P8 Completion Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Job queue and job events are durable. | PASS | DB schema, real enqueue/fetch/cancel, and persisted scheduled job completion. |
| 2 | Expired job leases recover safely. | PARTIAL | Unit/smoke coverage passed; destructive DB lifecycle smoke was not rerun on the unknown target. |
| 3 | Dashboard snapshots are persisted. | PARTIAL | Table/index/store reads passed; no full dashboard worker stage completed during this run. |
| 4 | Pipeline logic is extracted into service functions. | PASS | Pipeline-service smoke and static boundary checks passed. |
| 5 | Worker handlers call services, not API routes. | PASS | Worker static boundary checks passed. |
| 6 | Slow refresh routes enqueue jobs by default. | PASS | Both local refresh routes returned `202` queued responses. |
| 7 | Telegram `/refresh` enqueues jobs by default. | PARTIAL | Route helper/static smoke passed; no live Telegram webhook was invoked. |
| 8 | RefreshButton understands queued job status. | PASS | Route smoke state-helper checks passed. |
| 9 | `/api/signals` can read persisted snapshots. | PARTIAL | Persisted preference smoke passed; operational endpoint returned the clean empty state. |
| 10 | Scheduler can enqueue the paper-run pipeline. | PASS | Dry-run and real idempotent enqueue passed. |
| 11 | Paper position monitoring can run continuously from jobs. | PARTIAL | Paper-only handler and worker smokes passed; no continuous worker loop or open-position monitor run was performed. |
| 12 | No live broker/exchange execution is added. | PASS | Runtime, DB constraint, scheduler, handler, and static denylist checks passed. |
| 13 | Full validation passes. | PARTIAL | Local, build, non-destructive DB, route, scheduler, and one real worker job passed; destructive DB smoke and deployed hosting remain unverified. |

Summary: 7 PASS, 6 PARTIAL, 0 FAIL, 0 NOT TESTED in the P8 completion checklist.

## Issues Found

1. The configured DB target cannot be classified from local configuration, so destructive DB smoke is unsafe to rerun without operator confirmation.
2. The DB lifecycle smoke compares JSON using serialized key order. A prior gated run reported two false-negative metadata round-trip checks when Postgres returned the same values in a different object-key order.
3. A real five-symbol `features.compute` stage took about 169 seconds. Validation command wrappers and worker hosts need timeouts above realistic stage duration.
4. `/api/signals` returned a valid empty state because no non-expired dashboard snapshot had been generated yet.
5. Deployed Vercel environment settings, real cron history, and permanent worker hosting were not tested.
6. The production build retains a pre-existing `react-hooks/exhaustive-deps` warning in `SignalsPanel.tsx`.

## Follow-Up Tasks

1. Confirm whether the configured Supabase project is disposable/staging before any future truncate-gated smoke.
2. Change DB smoke metadata comparisons to order-insensitive deep equality, then rerun the gated lifecycle suite on a disposable DB.
3. Run the remaining scheduled stages through a supervised worker loop and verify that `dashboard.snapshot` makes `/api/signals` return persisted state.
4. Configure and verify Vercel production environment variables, including `SCHEDULER_SECRET`, without printing values.
5. Confirm at least one real Vercel Cron invocation and establish a supervised long-lived worker host.
