# P10 Operational Promotion Report

**Scope:** P10 continuation — merge, deploy, and production-verify P10B dashboard.snapshot hardening (PR #10), plus the P10C daily feature context scheduling fix (PR #12) that resolves the 1D feature staleness this report originally flagged as a warning. No P11 work (schema-safe GPT outputs, versioning, outcome tracking, risk engine, new strategies) was started.

**Date:** 2026-07-01 (P10B), updated 2026-07-01 (P10C)

## Deployment
- Production URL: `https://trading-teal-phi.vercel.app`
- Deployment URL: `trading-ljq8floph-jessie-rodelas-projects.vercel.app` (`dpl_HCynrTk9TQeXqae2sDG48b7eo9vv`)
- Commit SHA: `0be14ab3f6b1568ac51f430046452d558e033bbb`
- PR #10 merge SHA: `0be14ab3f6b1568ac51f430046452d558e033bbb` (regular merge commit, head `8c6aacf`, matches the required commit exactly)
- Deploy status: **READY** — Vercel's GitHub integration auto-deployed to production on merge; deployment's `githubCommitSha` matches the merge commit exactly; no manual deploy step was needed.

## P10B Verification
- **dashboard.snapshot source:** `persisted_feature_snapshots` — confirmed via the job's own persisted result (`dataQuality.symbols["BTC-USD"].barQuality.source`) on the first naturally-scheduled run after merge (job `37f02bdd-0cba-4dbc-bffd-c5876e6a15da`).
- **dashboard.snapshot runtime:** **440ms** post-merge vs **47,363ms** pre-merge (job `2263e906-f287-4dc8-abbf-b9debc0faeaf`, which ran ~20 minutes before the merge and used the legacy `taapi+yahoo` path) — a ~107x reduction, well beyond "materially lower."
- **Required log prefix observed:** could not be tailed directly (no remote shell access to the worker host — see Issues below). Verified equivalently via structured job-result and `job_events` data instead of raw stdout.
- **Forbidden log prefixes absent:** confirmed indirectly — the post-merge job's `dataQuality` carries `source: "persisted_feature_snapshots"` everywhere and contains no `DASHBOARD_PROVIDER_MIXED_CONTEXT` issue (that code only appears in the pre-merge job's result, tagged `source: "taapi+yahoo"`).
- **Persisted feature freshness behavior:** `freshness.oneHourLastUpdated` = `2026-07-01T20:00:00.000Z` (a real feature row timestamp, not adapter execution time) and, at the time of the original P10B check, `freshness.oneDayLastUpdated` = `2026-05-21T00:00:00.000Z`, which correctly triggered `DASHBOARD_1D_CACHE_STALE` (severity `warn`) for all 5 symbols — proving the freshness fix was live and working. **This staleness has since been resolved by P10C (PR #12) — see the P10C Verification section below.**
- **Stale-data smoke result:** PASS — `_smoke/dataQuality.ts`'s `runPersistedDashboardStalenessChecks` test (feeds intentionally stale 1H/1D rows through the real `createPersistedFeatureCacheAdapters` path) passes locally against the merged code. Kept unchanged by P10C; a new `runPersistedDashboardFreshDataChecks` test was added alongside it (see below).

## Worker Verification
- **Service status:** not directly queryable (no SSH/remote shell to `joon-OptiPlex-5090`). Inferred via `/api/ops/p8` → `worker.status: "recently_active"`.
- **Recent job sequence:** the first scheduled feed after merge (`closedBarTs 2026-07-01T20:58:57.401Z`, enqueued `21:05:26`) ran and **succeeded** for all six stages: `market.ingest.latest` (2.4s) → `features.compute` (~167s, 1500 features computed) → `regime.compute` (1.7s) → `strategies.evaluate` (~557s, 7 signals inserted) → `paper.monitor` (0.8s) → `dashboard.snapshot` (0.44s).
- **Restart count:** unknown — no remote shell access to confirm whether/how the worker process picked up the new code. Given the post-merge job ran with the new `dataSource: "persisted_feature_snapshots"` behavior within ~4 minutes of the merge landing, the worker was clearly running the updated code by then, whether via an automatic restart on the host or a per-invocation `tsx` re-resolution.
- **Errors/warnings:** none in the 24h window — `queue.counts` shows `failed: 0`, `expiredLeaseCount: 0`; `dead: 132` and `cancelled: 19` are pre-existing historical counts, not new failures from this deploy.

## Scheduler Verification
- **Timer status:** not directly queryable (no SSH).
- **Service status:** not directly queryable (no SSH).
- **Dry run result:** PASS — `npm run scheduler:feed -- --once --dry-run` plans exactly 6 stages, mutates nothing.
- **Real enqueue result:** PASS — ran `npm run scheduler:feed -- --once` twice in a row; both times all 6 stages returned `action: "skipped_succeeded"` referencing the **same** job IDs both times (dedupe keys correctly reused, no duplicate jobs created).
- **Six-stage feed result:** PASS — confirmed via `/api/ops/p8` that the natural post-merge scheduled feed completed all six stages successfully (see Worker Verification).

## Dashboard Snapshot Verification
- **Latest snapshot timestamp (generatedAt):** `2026-07-01T21:08:48.172Z`
- **Source job id:** `37f02bdd-0cba-4dbc-bffd-c5876e6a15da`
- **generatedAt:** `2026-07-01T21:08:48.172Z`
- **expires_at / isExpired:** `null` / `false`
- **/api/signals result:** HTTP 200; returns live `stats`/`derived`/`openai` fields sourced from the `dashboard_snapshots` row above (agent-disabled reasons show `openai_disabled`, consistent with the near-term P10 setting).
- **/api/ops/p8 result:** HTTP 200; `snapshot.latestDashboardSnapshot` matches the row above exactly (`publicId 86e6b447-d26c-4061-8291-135cea05b7c0`, `sourceJobPublicId 37f02bdd...`, `agentResultsCount: 6`, `confluenceCount: 5`, `symbols: [AVAX-USD, BTC-USD, ETH-USD, LINK-USD, SOL-USD]`).

## P10C Verification — 1D Feature Freshness Fix (PR #12)
- **Root cause:** the scheduled feed only ever drove `timeframe: "1h"` — nothing ever ran `market.ingest.latest`/`features.compute` with `timeframe: "1d"` on a recurring basis, even though those handlers already fully supported it. Not a P10B regression; P10B's freshness fix correctly *surfaced* this pre-existing gap instead of masking it.
- **Fix:** two new scheduled stages, `daily.market.ingest.latest` and `daily.features.compute`, run ahead of the normal 1H flow but dedupe against the closed **daily** bar — so on the existing hourly cron cadence they only do real work once per UTC day. `regime.compute`, `strategies.evaluate`, and `paper.monitor` remain 1h-only; no strategy or execution semantics changed.
- **1D market ingest job:** `daily.market.ingest.latest` (`f45628a3-d510-4015-bb86-deeef611171d`) — **succeeded**, 200 bars inserted (40/symbol × 5 symbols), `latestTs: 2026-06-30T00:00:00.000Z`.
- **1D features.compute job:** `daily.features.compute` (`29320dcf-a8bc-494b-9777-9d4d4bec8edf`) — **succeeded**, 200 features computed/inserted, `featureVersion: features.2026-05-20.v3`.
- **Latest 1D feature timestamp:** `2026-06-30T00:00:00.000Z` for all 5 symbols (BTC-USD, ETH-USD, SOL-USD, LINK-USD, AVAX-USD) — down from ~41 days stale to the latest closed daily bar. `source_lineage` present on all new rows.
- **Latest dashboard.snapshot (post-fix):** snapshot id `204`, `generatedAt: 2026-07-01T22:03:11.416Z`, source job `1192`. `dataQuality.symbols["BTC-USD"].freshness.oneDayLastUpdated = 2026-06-30T00:00:00.000Z`; `dataQuality.issues` contains only `DASHBOARD_VOLUME_UNAVAILABLE` (warn) × 5 — **`DASHBOARD_1D_CACHE_STALE` is absent.**
- **P10B guarantees re-confirmed on this run:** `barQuality.source: "persisted_feature_snapshots"`, `marketContext.dashboardDisplay.providers: ["coinbase"]`, no `DASHBOARD_PROVIDER_MIXED_CONTEXT`.
- **Idempotency:** reran the scheduler after the daily jobs succeeded — both `daily.*` stages returned `skipped_succeeded` referencing the identical job IDs; zero duplicate rows in `market_bars`/`feature_snapshots` for `timeframe=1d`.
- **Smoke coverage:** `runPersistedDashboardFreshDataChecks` (new) proves fresh 1D data emits no `DASHBOARD_1D_CACHE_STALE`/`DASHBOARD_1H_CACHE_STALE` and still reads `persisted_feature_snapshots`; also proves missing 1D context emits `DASHBOARD_1D_CONTEXT_MISSING` without being conflated with the stale-cache code. `runPersistedDashboardStalenessChecks` (P10B, kept) still passes unchanged. Scheduler plan/enqueue smoke tests updated for the 8-stage plan with isolated daily-vs-hourly dedupe/rollover assertions.
- **Deploy:** PR #12 merged via merge commit `44b6844`; Vercel auto-deployed to production (`dpl_3ZhHnxFtZioXdoaWcxL9tkVoguAN`, `READY`, commit SHA matches exactly). Post-deploy endpoint recheck: `/dashboard`, `/api/ops/p8`, `/api/signals`, `/api/jobs/status`, `/api/regime/BTC` all HTTP 200.

## Source Lineage Verification
- **Audit result:** PASS (exit 0) — warn-only, unchanged in nature from pre-deploy.
- **Strict audit result:** PASS (exit 0) — same warn-only findings, **no block-severity issues**.
- **Latest lineaged rows:** 100% of rows inserted in the last 2 hours carry `source_lineage`: `market_bars` 10/10, `feature_snapshots` 10/10, `regime_snapshots` 10/10, `strategy_signals` 15/15. No duplicate `(symbol, exchange, timeframe, ts)` groups found in `market_bars` or `(..., feature_version)` in `feature_snapshots`.
- **Legacy warnings:** `market_bars` 96230/96245 missing lineage, `feature_snapshots` 94290/94305, `regime_snapshots` 194092/194107, `strategy_signals` 2283/2648 — entirely pre-existing historical backlog (pre-P9C), confirmed unaffected by this deploy.

## Validation Summary
| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS |
| `npm run smoke:scheduler-bootstrap` | PASS (P10C: 8-stage plan, daily/hourly dedupe isolation) |
| `npm run smoke:pipeline-services` | PASS |
| `npm run smoke:job-worker` | PASS |
| `npm run smoke:data-quality` | PASS (P10B stale-1D test kept; P10C fresh-1D + missing-1D-context tests added) |
| `npm run smoke:source-lineage` | PASS |
| `npm run audit:source-lineage` | PASS (exit 0, warn-only) |
| `SOURCE_LINEAGE_STRICT=1 npm run audit:source-lineage` | PASS (exit 0, warn-only, no blocks) |
| `npm run validate:p8:operational` | PASS (updated for 8-stage plan) |
| `npm run scheduler:feed -- --once --dry-run` | PASS (8 stages planned, no mutation) |

## Issues Found
**Blocking:** none.

**Non-blocking:**
1. This session has no SSH/remote-shell access to the external Linux worker host (`joon-OptiPlex-5090`), so direct `systemctl`/`journalctl` verification could not be executed. Worker and scheduler health were instead verified indirectly through the shared production Postgres DB and the `/api/ops/p8` endpoint — sufficient to prove the merged code is running correctly in production (confirmed twice now, across both PR #10 and PR #12 deploys), but it does not capture raw stdout log lines or an actual restart count. **This is the only remaining warning.**
2. ~~Persisted 1D `feature_snapshots` were ~41 days stale~~ — **resolved by P10C (PR #12).** 1D market ingest and feature compute now run on a recurring daily-context schedule; `DASHBOARD_1D_CACHE_STALE` no longer fires on fresh production runs (verified above).
3. `features.compute` (~167s) and `strategies.evaluate` (~557s) took materially longer than the other stages in the P10B observation run. Not a P10B or P10C regression — unrelated to either fix — but still worth its own investigation if closed-bar-to-snapshot latency matters operationally.

**Follow-up recommended:**
1. If literal systemd/journalctl confirmation is required, run the equivalent verification directly on the Linux host, or grant this session remote access.
2. Update `md/changes-updates/REPOSITORY_ISSUES.md` Tier-2 item #4 to reflect closure (flagged in the prior P10B session, still pending).
3. Investigate the `features.compute`/`strategies.evaluate` stage latency noted above (non-blocking, unrelated to P10B/P10C).

## Promotion Decision

**P10 — PROMOTED WITH WARNINGS**

Every functional acceptance criterion is met across both PR #10 and PR #12: both merged, `main` auto-deployed to production each time, the next natural scheduled run completed all pipeline stages (six, then eight after P10C), `dashboard.snapshot` runs from persisted `feature_snapshots` with no TAAPI/cache-refresh signature and a ~107x runtime improvement, 1H **and 1D** freshness now correctly reflect real, current feature timestamps with no stale-cache issues on fresh runs, `/api/signals`/`/api/ops/p8`/`/api/regime/BTC` all read persisted state correctly, source-lineage audits (both modes) pass with no block issues, the build passes, and no live-execution code was introduced. The sole remaining warning is environmental, not a production failure: this session's lack of direct shell access to the Linux worker host. Per the stated decision rule, that alone keeps this at PROMOTED WITH WARNINGS rather than plain PROMOTED.
