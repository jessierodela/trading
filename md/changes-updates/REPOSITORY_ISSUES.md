# Repository Issues — Outstanding Work

**Generated:** 2026-05-29
**Last revised:** 2026-06-26 (after PRs #5 and #6 — Tier 1 essentially cleared)
**Source:** Code review of `main` (HEAD `32c4e61`) against `md/ai-instructions/QUANT_DESK_CONVERSION_PLAN.md` (dated 2026-05-13).

This document captures the concrete, file-cited gaps between the current codebase and the lightweight quant desk target. Items are tiered by impact, not by plan priority — Tier 1 blocks production, Tier 5 is research debt. Each item names the file or directory it lives in, the symptom, and what done looks like.

A spreadsheet view of the same data lives at `QUANT_DESK_STATUS.xlsx` (in OneDrive). When this file and the spreadsheet disagree, this file wins.

---

## What changed since 2026-05-29

Two major arcs, in roughly chronological order:

### 2026-06-11 — Risk engine + paper-broker direct-push spree, then PR #4

| SHA | Subject | Route | Effect |
|---|---|---|---|
| `ee9ba1e` | Harden P5 research for risk readiness | Direct push | Tier 5 prep |
| `f89e277` | Build deterministic P6A risk engine core | Direct push | **Closed Tier 1 #1.** Bumped `RISK_VERSION`. |
| `6c70111` | Make P6A stop fallback explicit | Direct push | Hardened Tier 1 #1. |
| `1c1724e` | Add optional P6B risk backtest overlay | Direct push | Backtest-side integration. |
| `b4f5e54` | Add P6C trade intent simulation layer | Direct push | Added `lib/tradeIntent/` (in-memory). |
| `b86e96d` → `d1599bc` | Add P7A paper trading core | **PR #4** | **Closed Tier 1 #2.** Added `lib/execution/*` (in-memory). |

### 2026-06-16 — PR #5: Complete Priority 7 paper trading

| SHA | Subject | Phase |
|---|---|---|
| `13e98d6` | Add P7B paper trading persistence | Migration 0002, postgresTradeIntentStore, postgresPaperTradingStore |
| `804460d` | Add P7C paper trading API routes | `/api/orders/paper`, `/api/orders/paper/fill`, `/api/positions` |
| `da7e230` | Add P7D paper trading dashboard panel | 6 components (PaperTradingPanel + sub-panels) |
| `e82e4d0` | Add P7E paper trading run harness | paperTradingWorkflow, paperTradingReadiness, paperTradingApi |
| `31b91a4` | Merge pull request #5 | — |

**Effect:** Closed Tier 1 #2F (Postgres persistence) and #2G (API + dashboard + harness).

### 2026-06-23 — PR #6: Priority 8 durable jobs + scheduler + operational dashboard

| SHA | Subject | Phase |
|---|---|---|
| `7f7e164` | Add P8A job queue core | `lib/jobs/jobStore.ts`, `postgresJobStore.ts`, migration `0003` |
| `7d68795` | Harden P8A job lifecycle guards | Atomic lock/release semantics |
| `6a65163` | Add P8A migration drift repair workflow | `scripts/repairMigration0001Drift.ts` |
| `ab400c9` | Add P8B pipeline service extraction | `lib/pipeline/` — 4 pipeline modules |
| `4380916` | Add P8C job worker handlers | `lib/jobs/handlers/` — 7 handlers |
| `ee2504e` | Add P8D route job enqueue + status flow | 4 new `/api/jobs/*` routes; `/api/cache/refresh` now enqueues |
| `7652cf2` | Fix regime route persisted reads | Bug fix in `/api/regime/[symbol]` |
| `43b08b7` | Add P8E scheduler bootstrap | `lib/jobs/scheduler/`, `scripts/enqueueScheduledFeed.ts` |
| `9732d6b` / `8c97a9a` | P8 operational validation | `scripts/validateP8Operational.ts`, `lib/ops/p8Summary.ts` |
| `605be7a` / `0fa6711` | P8 dashboard operations visualization | 10 components under `components/dashboard/ops/` |
| `4a56f06` / `14568c8` | Use external Linux scheduler for P8 | Systemd timer integration |
| `32c4e61` | Merge pull request #6 | — |

**Effect:** Closed Tier 1 #3 (jobs queue). Introduced one new operational follow-up (SCHEDULER_SECRET).

**Net:** Tier 1 went from 3 hard blockers (risk / paper broker / jobs) on 2026-05-29 → **1 remaining wire-up (#1F) + 1 operational deployment (SCHEDULER_SECRET) + plan-defined 30-day paper run**.

---

## Tier 1 — Production blockers

### ~~1. No risk layer~~ — RESOLVED 2026-06-11

Closed by `f89e277` + `6c70111`. `lib/risk/{riskEngine,types,positionSizing,stops,killSwitch,riskInputAdapter}.ts` (545 lines, 24 block reasons). `RISK_VERSION` = `"risk.2026-06-11.v1"`.

### ~~2. No execution layer~~ — RESOLVED 2026-06-11 via PR #4

Closed by PR #4 (commit `b86e96d` → merge `d1599bc`). `lib/execution/{paperBroker,paperPosition,orderManager,fillSimulator,types,index}.ts` (455 lines). Lineage chain signal → strategy → risk → intent → paper order → fill → position now exists in code.

### ~~3. Refresh pipeline is synchronous and memory-only~~ — RESOLVED 2026-06-23 via PR #6

Closed by PR #6 P8A–P8E.

- **P8A queue** — `lib/jobs/jobStore.ts` + `postgresJobStore.ts`; new `jobs` table (migration `0003_jobs_and_dashboard_snapshots.sql`) with `public_id uuid`, `status`, `priority`, `payload jsonb`, `dedupe_key`, `run_after`, `attempts`, `max_attempts`, `locked_by`. Atomic lifecycle guards.
- **P8B pipeline extraction** — `lib/pipeline/{dashboardRefreshPipeline,dashboardSnapshotPipeline,marketIngestPipeline,regimeRefreshPipeline}.ts`. The synchronous logic from the legacy `/api/cache/refresh` and `/api/regime/refresh` was refactored into pure pipeline functions consumed by both routes and job handlers.
- **P8C worker handlers** — `lib/jobs/handlers/{dashboardSnapshot,featuresCompute,marketIngestLatest,paperMonitor,regimeCompute,strategiesEvaluate,telegramRefresh}.ts`. Plus `scripts/runJobWorker.ts` + `npm run worker:jobs`.
- **P8D route enqueue + status** — new `/api/jobs/refresh`, `/api/jobs/schedule`, `/api/jobs/status`, `/api/jobs/[id]`. `/api/cache/refresh` now enqueues by default; sync mode retained behind `?mode=sync` for legacy callers.
- **P8E scheduler bootstrap** — `lib/jobs/scheduler/{closedBar,scheduledFeed}.ts`, `scripts/enqueueScheduledFeed.ts`, external Linux scheduler (systemd timer).
- **Ops** — `scripts/validateP8Operational.ts`, `lib/ops/p8Summary.ts`, `lib/ops/p8Types.ts`. 10 ops components under `components/dashboard/ops/` (P8OperationsConsole, P8OpsUI, P8PipelineTracker, P8ProductionChecklist, P8QueueHealth, P8RegimeFreshness, P8SchedulerStatus, P8SnapshotFreshness, P8SystemFlow, P8WorkerStatus).

**Remaining follow-up:** SCHEDULER_SECRET deployment — see new Operational item below.

---

## Tier 1 follow-ups (status as of 2026-06-26)

### 1F. Wire risk engine into the live signal path — STILL OPEN

**Symptom:** `lib/risk/riskEngine.ts` ships and the smoke test passes, but no caller in the live or worker path imports `lib/risk`. Verified via `grep -l "@/lib/risk" lib/jobs/handlers/*.ts lib/pipeline/*.ts` — zero matches. The P8C `strategiesEvaluate` handler emits signals that bypass risk; nothing in the dashboard-refresh pipeline calls `riskEngine.decide(...)` before persisting an actionable signal.

**Done looks like:** Either `strategiesEvaluate` or a new `riskGate` handler calls `riskEngine.decide(input)` before persisting; rejected signals carry the `RiskDecision` with blocked-by reasons; dashboard surfaces approval/rejection counts; smoke covers the approval + rejection paths.

### ~~2F. Persist trade lineage to Postgres~~ — RESOLVED via PR #5

Closed by PR #5 P7B.

- Migration `0002_paper_trading_persistence.sql` — additive: extends `trade_intents` with `timeframe`, `source_signal_refs`, `strategy_id`, `strategy_version`, `feature_version`, `entry_price`, `metadata`, `created_at`, `expires_at`; backfills from existing rows.
- `lib/tradeIntent/postgresTradeIntentStore.ts` — implements `TradeIntentStore` against the `trade_intents` table.
- `lib/execution/postgresPaperTradingStore.ts` + `storeTypes.ts` — orders, fills, positions persisted.
- Smoke: `_smoke/paperTradingPersistence.ts`.

### ~~2G. API surface for paper trading~~ — RESOLVED via PR #5

Closed by PR #5 P7C + P7D + P7E.

- API: `app/api/orders/paper/route.ts`, `app/api/orders/paper/fill/route.ts`, `app/api/positions/route.ts`.
- Dashboard: `components/dashboard/{PaperTradingPanel,PaperTradingPanelView,PaperPnlSummary,OpenPositionsTable,ClosedTradesTable,PaperRiskLineagePanel}.tsx`.
- Run harness: `lib/execution/{paperTradingWorkflow,paperTradingReadiness,paperTradingApi}.ts` + `_smoke/paperTradingApi.ts`, `_smoke/paperTradingDashboard.tsx`, `_smoke/paperTradingWorkflow.ts`.

---

## Operational follow-ups (new 2026-06-23)

### O1. Deploy SCHEDULER_SECRET — required to enable Linux systemd timer

**Where:** `lib/jobs/scheduler/scheduledFeed.ts:316` reads `env.SCHEDULER_SECRET?.trim()` to authenticate scheduler-driven enqueues. `lib/ops/p8Summary.ts` surfaces presence/absence in the operational dashboard. `scripts/validateP8Operational.ts` logs presence.

**Symptom:** P8 stack ships; tables exist; routes exist; worker exists. But the external Linux scheduler cannot enqueue without the shared secret. Until SCHEDULER_SECRET is set in both Vercel and on the scheduler host, the systemd timer is intentionally not enabled.

**Done looks like:** SCHEDULER_SECRET configured in Vercel env vars and on the Linux scheduler host (matching values); systemd timer enabled; `npm run validate:p8:operational` reports SchedulerStatus = green; P8 ops dashboard shows scheduler authenticating successfully end-to-end.

### O2. 30-day continuous paper trading run

**Where:** `lib/execution/paperTradingWorkflow.ts` (the harness ships via PR #5 P7E).

**Symptom:** Plan's P7 acceptance bar: *"Paper trading runs continuously for at least 30 days. Every trade has a linked signal, regime, features, and risk decision."* The harness exists but no 30-day run has been recorded.

**Done looks like:** 30 consecutive days of paper trading captured in `trade_intents` + `orders` + `fills` + `positions`; dashboard PaperPnlSummary shows the full window; lineage column populated end-to-end. **Should wait until #1F is closed** so trades are actually risk-checked.

---

## Tier 2 — Silent correctness and data-quality risks

### 4. Two indicator pipelines coexist — STATUS DRIFT, needs verification

**Where:**
- New (validated): `lib/features/engine.ts`, `feature_snapshots`, P2D GO.
- Old: `lib/indicatorCache.ts`, `lib/taapi.ts`, `lib/taapi1d.ts` — still present in the tree.
- New ingest path: `lib/jobs/handlers/marketIngestLatest.ts` + `lib/pipeline/marketIngestPipeline.ts` (PR #6 P8C).

**Symptom:** PR #6 P8C introduced a `marketIngestLatest` handler — this may already be the canonical ingest path under the queue. But `lib/indicatorCache.ts` and `lib/taapi*.ts` are still in the tree and not labeled deprecated in code. Whether the live `/api/cache/refresh` enqueued path now reads from `feature_snapshots` end-to-end, or still calls into TAAPI, is not verified.

**Done looks like:** Either `lib/indicatorCache.ts` and `lib/taapi*.ts` are deleted (or moved to a `legacy/` namespace and removed from active imports), or this issue is closed with a documented finding that they remain only as debug/comparison tools.

### 5. Mixed canonical symbols

**Where:** `lib/indicatorCache.ts:254` overrides volume with `yahoo-finance2`; agents reference the same. No `lib/data/symbolMap.ts`.

**Plan reference:** Priority 9.

**Done looks like:** `lib/data/symbolMap.ts` exists; storage validators enforce canonical symbols.

### 6. GPT outputs validated by `JSON.parse(clean)` only

**Where:** Six agents — `breakoutWatcher:228`, `meanReversion:237`, `momentumScout:319`, `regimeDetector:537`, plus `trendFollower` and `volatilityArbiter`.

**Plan reference:** Priority 10.

**Done looks like:** `zod` added as direct dep; `lib/agents/schemas.ts` exports one schema per agent; retry once on invalid; persist raw + parse error.

### 7. No outcome tracking

**Where:** No `signal_outcomes` table. No `evaluateSignalOutcomes` job handler. `lib/jobs/handlers/` has 7 handlers but none populate forward-return columns.

**Plan reference:** Priority 12.

**Done looks like:** Migration `0004_signal_outcomes.sql`; new `lib/jobs/handlers/evaluateSignalOutcomes.ts` periodically populates `return_1h/4h/12h/24h`, MFE, MAE, regime_at/after.

---

## Tier 3 — Process and repository hygiene

### 8. PR discipline restored but not enforced

**Symptom:** PRs #4, #5, #6 all went through the proper flow — the last three production merges have been review-trail-friendly. The Claude Code GitHub Actions workflow has finally had something to run on. But discipline is still social, not mechanical — direct pushes to `main` remain possible.

**Done looks like:** Branch protection on `main` requiring PR + green CI before merge. Make the PR-less direct push impossible.

### ~~9. Stale branches on remote~~ — RESOLVED (recurring, but currently clean)

Origin and local clone show only `main`. PRs #5 and #6 used `--delete-branch` on merge; PR #4 was deleted manually; the May/June direct-push branches were swept twice. Tier 3 #8 (branch protection) prevents this from recurring.

---

## Tier 4 — Small code-level smells

### 11. `lib/polygon.ts` is named after the wrong provider

Still polygon.ts despite using yahoo-finance2.

### 12. `next` is pinned at `15.5.18` with no `npm audit` record

Plan's P0.5 still has an open audit step.

### 13. `lib/confluence/*` labeled LEGACY but still authoritative

Transition note points at `lib/strategies/arbitrator.ts` — still does not exist.

### ~~14. `RISK_VERSION = "risk.v1"` stub~~ — RESOLVED 2026-06-11

`RISK_VERSION` now `"risk.2026-06-11.v1"`.

---

## Tier 5 — Open research debt

### 15. P5 router validation NOT VALIDATED — status not re-checked

**Where:** `P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md`, walk-forward sections; `reports/p5/`.

**Symptom:** Last documented OOS verdict was `NOT VALIDATED` on BTC, ETH, SOL, LINK, AVAX (0/3 folds). PRs #5 and #6 are infrastructure work — they do not change the research verdict. The plan's #15 — at least one variant must validate before paper trading — is still gating the 30-day run.

**Done looks like:** At least one refined variant documented as PASS across 3/3 folds on at least one asset; verdict captured in `reports/p5/`.

### 16. Strategy registry doubled 4→8 — split not implemented

**Where:** `lib/strategies/strategyRegistry.ts` spreads `REFINED_STRATEGY_VARIANTS`. Five call sites iterate the full registry, including the P8C `strategiesEvaluate` handler that runs under the live worker. Refined variants currently fire alongside base strategies in production.

**Done looks like:** `STRATEGY_REGISTRY_LIVE` (validated only) vs `STRATEGY_REGISTRY_RESEARCH` (full); P8C handler reads only the LIVE subset; research scripts read the full RESEARCH subset.

---

## Mapping back to the plan

| Plan priority             | Tier | Item(s)                                                       |
|---------------------------|------|---------------------------------------------------------------|
| P0.5  npm audit           | 4    | #12                                                           |
| P6    Risk engine         | 1    | **#1 RESOLVED**, follow-up **#1F still open**                 |
| P7    Paper trading       | 1    | **#2, #2F, #2G RESOLVED**, O2 (30-day run) open               |
| P8    Jobs queue          | 1    | **#3 RESOLVED**, **O1 (SCHEDULER_SECRET) open**               |
| P9    Data quality        | 2    | #5                                                            |
| P10   Zod schemas         | 2    | #6                                                            |
| P11   Versioning          | 4    | **#14 RESOLVED**                                              |
| P12   Outcome tracking    | 2    | #7                                                            |
| Folder structure          | —    | All present: lib/risk + lib/tradeIntent + lib/execution + lib/jobs + lib/pipeline + lib/ops |
| Live cutover off TAAPI    | 2    | #4 (needs verification — possibly partially shifted by P8C)   |
| API route revisions       | 4    | #11, #13                                                      |
| PR discipline             | 3    | #8 (item #9 RESOLVED — currently clean)                        |
| P5 research               | 5    | #15, #16                                                      |

## Suggested execution order (revised 2026-06-26 post-PR #6)

1. **O1 (SCHEDULER_SECRET)** — small but blocks the systemd timer. Do this first; it's a config push.
2. **#1F (Wire risk into live path)** — the highest-impact remaining engineering task. P8C `strategiesEvaluate` is the obvious integration point; the risk engine + decision plumbing already exists.
3. **#16 (Strategy registry split)** — prevents un-validated refined variants from firing in the live worker. Cheap; high safety value once #1F lands.
4. **#15 (P5 OOS validation)** — research blocker. Until at least one variant validates, paper-trading is technically wired but operationally meaningless.
5. **O2 (30-day paper run)** — start *after* #1F + #15 so trades are risk-checked and at least one underlying strategy has external validation.
6. **#6 (zod), #7 (outcomes), #4 (TAAPI cutover verification), #5 (canonical symbol)** — in parallel during the paper-run window.
7. **Tier 4 cleanup (#11, #12, #13)** — fold into whatever PR is open at the time.
8. **#8 (branch protection)** — once the team is on a clean PR cadence (4 in a row), make it the rule rather than the convention.
