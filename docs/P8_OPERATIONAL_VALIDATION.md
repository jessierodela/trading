# P8 Operational Validation

> Historical closeout record. Scheduler ownership has since moved from Vercel Cron to an external Linux systemd timer. See [P8_LINUX_SCHEDULER.md](./P8_LINUX_SCHEDULER.md) for the current production runbook.

Branch: `ai/p8-operational-closeout`

Base commit: `9732d6b37fa244a40b4a2a44b9a826a431e179fa`

Date: 2026-06-22

Environment: local Windows/Next.js processes with hosted Postgres, plus read-only Vercel project inspection

DB target: unknown (hosted Supabase; not confirmed disposable, staging, or production)

Secrets printed: no

Local environment presence:

```text
SUPABASE_DB_URL present: yes
DATABASE_URL present: no
SCHEDULER_SECRET present: no
```

## Commands Run

- `npm.cmd exec -- tsc --noEmit --pretty false`
  - PASS
- `npm.cmd run migrate:status`
  - Initial FAIL: legacy checksums were line-ending-sensitive across LF/CRLF worktrees.
  - Final PASS: no pending migrations; three applied.
- `npm.cmd run repair:migration:0001`
  - PASS, dry-run only.
  - The stored checksum was accepted as a legacy LF/CRLF variant and no repair was applied.
- `npm.cmd run smoke:jobs`
  - PASS.
  - New focused checks prove object-key order is ignored and array order remains significant.
  - DB lifecycle section skipped because the destructive gate was not enabled.
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
  - PASS.
  - Planned six stages for closed bar `2026-06-22T18:00:00.000Z` without a DB write.
- `npm.cmd run validate:p8:operational`
  - PASS, all 43 non-destructive checks.
- `npm.cmd run worker:jobs -- --once`
  - PASS for `regime.compute`.
  - PASS for `strategies.evaluate`.
  - Initial FAIL before claim for `paper.monitor`: transient Postgres `ECONNRESET`.
  - Retry PASS for `paper.monitor`; persisted attempts remained one because the failed command never claimed it.
  - PASS for `dashboard.snapshot`.
- `npm.cmd run dev -- --port 3000`
  - Initial FAIL: port already occupied by an unrelated process.
- `npm.cmd run dev -- --port 3001`
  - PASS for branch-specific browser and route verification; server stopped afterward.
- `npm.cmd run build`
  - PASS with no React hook dependency warning.
- Vercel CLI project, environment, deployment, route, and log inspection
  - PASS for metadata reads.
  - Production scheduler/cron verification did not pass because P8E is not deployed to production.
- `REQUIRE_DB_SMOKE=1 SMOKE_ALLOW_TRUNCATE=1 npm.cmd run smoke:jobs`
  - SKIPPED because the configured DB is not confirmed disposable.

## Hardening Changes

### DB smoke equality

PASS.

`_smoke/jobs.ts` now uses Node deep strict equality. JSON object insertion order is ignored, nested values are still compared, and array order remains significant. Production job-store behavior was not changed.

### Migration checksum portability

PASS.

The migration SQL files were not edited. The runner now records canonical LF checksums for new migrations while accepting legacy LF or CRLF checksums for already-applied files. This prevents `core.autocrlf` from creating false drift without weakening content-drift detection. The existing `0001` repair helper uses the same compatibility rules.

Final migration result:

```text
No pending migrations. 3 applied.
```

### SignalsPanel warning

PASS.

The poll callback is memoized with `useCallback`, and the effect lists `applyPayload` and `poll` as dependencies. The production build completed without the prior `react-hooks/exhaustive-deps` warning.

## DB Validation

PASS for non-destructive operational checks.

- All required P8 tables, indexes, and named constraints exist.
- Runtime and DB allowlists include the seven P8 job types and exclude forbidden live-execution types.
- A uniquely keyed future validation job was enqueued, fetched, listed, and cancelled cleanly.
- Latest dashboard snapshot reads complete successfully.
- Scheduler dry-run left the job count unchanged.

The order-insensitive assertion fix is covered by focused smoke checks. The complete truncate-gated DB lifecycle suite still requires explicit confirmation that the target is disposable.

## Scheduled Worker Completion

All six jobs for closed bar `2026-06-19T15:00:00.000Z` are `succeeded`. No scheduled job is queued, failed, or dead.

| Stage | Public job ID | Attempts | Started | Completed | Result summary |
|---|---|---:|---|---|---|
| `market.ingest.latest` | `770e7c70-7a4c-46d8-ae79-988a884e20ec` | 1 | `2026-06-19T16:35:52.787Z` | `2026-06-19T16:35:59.684Z` | 3,440 fetched and inserted; 0 skipped |
| `features.compute` | `e145a776-bad5-4dd6-ac30-cd944f78389f` | 1 | `2026-06-19T16:58:50.699Z` | `2026-06-19T17:01:39.838Z` | 1,500 bars/features inserted; 0 duplicates |
| `regime.compute` | `1c0af1d9-882f-4b86-a947-97447628a8a4` | 1 | `2026-06-22T18:49:43.780Z` | `2026-06-22T18:50:09.834Z` | 5 persisted-feature computations; 0 transitional fallbacks |
| `strategies.evaluate` | `2dc492c7-19ec-479f-8d08-3977297ab485` | 1 | `2026-06-22T18:50:30.467Z` | `2026-06-22T18:50:58.490Z` | 465 features read; 466 signals inserted; 0 duplicates |
| `paper.monitor` | `1427ac8a-9fb0-438e-857b-590251cde3bf` | 1 | `2026-06-22T18:52:00.919Z` | `2026-06-22T18:52:01.779Z` | `paperOnly=true`; no open positions to update |
| `dashboard.snapshot` | `24283a34-9386-41f6-a0e7-c64af02f1daf` | 1 | `2026-06-22T18:52:21.736Z` | `2026-06-22T18:53:19.324Z` | Snapshot persisted; pipeline duration 56,716 ms |

The transient `ECONNRESET` before the paper-monitor retry did not claim or mutate the job. The successful retry is the only persisted attempt.

## Dashboard Snapshot And Routes

PASS.

The scheduled dashboard job persisted snapshot `eb93c90a-693c-4ee8-af32-ed67d33a1e6f`, generated at `2026-06-22T18:53:18.106Z`. Its payload includes `generatedAt`, `agentResults`, `activity`, `stats`, `regimeMap`, `confluence`, indicators, and derived data.

Local checks against the closeout branch on port `3001`:

- `GET /api/signals`: `200`; six agent results, nine activity entries, stats, and persisted `generatedAt` returned.
- Server log: `HIT dashboard_snapshots generatedAt=2026-06-22T18:53:18.106Z`.
- `GET /api/regime/BTC`: `200`; persisted `LOW_VOL` data returned with timestamp `2026-06-19T15:00:00.000Z`.
- `GET /api/jobs/schedule`: `401` without scheduler credentials.
- `GET /api/jobs/schedule?dryRun=1`: `200`; six dry-run jobs; protected by `local_dry_run`.

Browser verification returned `200`, rendered meaningful content, and showed no framework error overlay. The observed `401` console entry was the intentional unauthorized scheduler test; one ancillary `404` resource entry did not affect the validated routes.

## Queue Remainder

No scheduled jobs remain active or terminal-failed.

The shared DB still contains:

- Seven queued non-scheduled records: five prior DB-smoke fixtures and two manual route-validation jobs.
- One failed prior smoke fixture: `strategies.evaluate`, error `bad payload`.
- Two dead prior smoke fixtures: `regime.compute` with `exhausted`, and `telegram.refresh` with an expired max-attempt lease.

These records were not deleted because the DB target is not confirmed disposable and cleanup was not explicitly authorized.

## Vercel Environment Readiness

PARTIAL.

Only names and scopes were inspected; no values were retrieved or printed.

| Variable | Production | Preview | Development |
|---|---|---|---|
| `SUPABASE_DB_URL` | present | present | absent |
| `DATABASE_URL` | absent | absent | absent |
| `SCHEDULER_SECRET` | absent | absent | absent |
| `SCHEDULED_FEED_SYMBOLS` | absent | absent | absent |
| `SCHEDULED_FEED_EXCHANGE` | absent | absent | absent |
| `SCHEDULED_FEED_TIMEFRAME` | absent | absent | absent |
| `SCHEDULED_FEED_SOURCE` | absent | absent | absent |
| `OPENAI_API_KEY` | present | present | present |
| `TAAPI_API_KEY` | present | present | present |
| `POLYGON_API_KEY` | present | present | present |

The scheduler has validated code defaults for all `SCHEDULED_FEED_*` settings. With no `SCHEDULER_SECRET`, deployed cron requests must rely on the verified Vercel Cron user-agent authorization path. Explicit production configuration remains recommended.

## Vercel Cron Validation

NOT TESTED in production because the required deployment does not exist yet.

- Repository `vercel.json` correctly defines `/api/jobs/schedule` at `5 * * * *`.
- Latest production deployment was created on 2026-06-16, before P8E closeout.
- Production `GET /api/jobs/schedule` returned `404`, proving the current deployment does not contain the scheduler route.
- Seven-day production runtime-log search found no `/api/jobs/schedule` invocation.
- The DB contains no newer cron-created scheduled feed beyond the locally enqueued 2026-06-19 closed bar.

A real cron invocation cannot be marked PASS until P8 is merged and deployed to production.

## Worker Hosting

PARTIAL. Real one-shot workers are verified; permanent hosting is not configured.

Operational command:

```powershell
npm.cmd run worker:jobs -- --loop --poll-ms 5000 --lease-ms 60000
```

Recommended host: Railway/Render background worker or a small VPS/systemd service. The host needs `SUPABASE_DB_URL` (or `DATABASE_URL`) plus provider variables used by enabled handlers. It should forward `SIGINT`/`SIGTERM`, allow the loop to abort, and let the script close its Postgres pool.

Set process and platform timeouts comfortably above five minutes. The observed `features.compute` run took about 169 seconds, while the full dashboard snapshot took about 57 seconds. Monitor claim/completion/failure events, heartbeat failures, lease recovery, provider errors, and Postgres connection resets.

No permanent worker host or temporary loop was configured in this branch.

## P8 Completion Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Job queue and job events are durable. | PASS | DB-backed lifecycle state persisted across multiple days and worker processes. |
| 2 | Expired job leases recover safely. | PASS | Worker/DB lifecycle checks and persisted expired-lease smoke records verify recovery paths. |
| 3 | Dashboard snapshots are persisted. | PASS | Scheduled dashboard worker persisted a linked snapshot with full payload. |
| 4 | Pipeline logic is extracted into service functions. | PASS | Pipeline-service and static boundary smokes pass. |
| 5 | Worker handlers call services, not API routes. | PASS | Worker static boundary checks pass. |
| 6 | Slow refresh routes enqueue jobs by default. | PASS | Route enqueue behavior and public status contracts pass. |
| 7 | Telegram `/refresh` enqueues jobs by default. | PARTIAL | Route helper/static smoke passes; no live Telegram webhook was invoked. |
| 8 | RefreshButton understands queued job status. | PASS | Route smoke state-helper checks pass. |
| 9 | `/api/signals` can read persisted snapshots. | PASS | Operational route returned the scheduled persisted dashboard payload. |
| 10 | Scheduler can enqueue the paper-run pipeline. | PASS | Real six-stage feed exists and all stages completed. |
| 11 | Paper position monitoring can run continuously from jobs. | PARTIAL | Real paper-only scheduled job passed; permanent loop hosting is not configured. |
| 12 | No live broker/exchange execution is added. | PASS | Runtime, DB, scheduler, handler, and static denylist checks pass. |
| 13 | Full validation passes. | PARTIAL | Local/DB pipeline is complete; destructive DB smoke, production deployment/cron, and permanent worker hosting remain open. |

Summary: 10 PASS, 3 PARTIAL, 0 FAIL, 0 NOT TESTED in the P8 completion checklist.

## Issues Found

1. Production does not yet contain P8E; the scheduler route is `404`, so Vercel Cron cannot fire.
2. Production lacks `SCHEDULER_SECRET` and explicit `SCHEDULED_FEED_*` variables. Code defaults and Vercel Cron user-agent auth are validated, but deployment configuration is implicit.
3. Permanent worker hosting is not configured.
4. The truncate-gated DB lifecycle smoke was not rerun because the target is not confirmed disposable.
5. Seven queued and three failed/dead non-scheduled validation fixtures remain in the shared DB.
6. One worker startup encountered a transient Postgres `ECONNRESET` before claim; retry succeeded without consuming an attempt.

## Follow-Up Tasks

1. Merge the P8 branch stack and deploy it to Vercel production.
2. Add explicit production scheduler configuration, or formally document reliance on code defaults and Vercel Cron user-agent auth.
3. After deployment, verify `/api/jobs/schedule` returns `401` manually and confirm a real cron-created feed in logs and DB.
4. Provision a supervised long-lived worker and confirm clean shutdown/restart behavior.
5. Run the truncate-gated DB lifecycle smoke only after an operator confirms a disposable/staging target.
6. Clean old validation fixtures only with explicit authorization for the target DB.
