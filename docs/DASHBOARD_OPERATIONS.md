# Dashboard Operations & Data Honesty

## Purpose

`/dashboard` is a read-only operations-state dashboard for the trading
intelligence platform. It answers, at a glance:

1. What is this platform doing?
2. What stage is the system currently in?
3. Which parts are live, static, stale, blocked, or disabled?
4. What jobs are queued, running, completed, failed, or dead?
5. What is safe to trust right now?
6. What still needs engineering work before live execution could ever be considered?

It is **not** a trading terminal. There is no order entry, no broker action,
and no way to mutate state from the dashboard.

## Page structure

| Section | Component | Data source |
| --- | --- | --- |
| 1. Platform Overview | `PlatformOverview` | Static copy describing design intent and code-level facts |
| 2. System Flow Map | `SystemFlowMap` | `/api/ops/system-state` (live) |
| 3. Current Operations State | `P8SchedulerStatus`, `P8WorkerStatus`, `P8SnapshotFreshness`, `P8ProductionChecklist` | `/api/ops/system-state` (live) |
| 4. Jobs & Pipeline Tracker | `P8PipelineTracker`, `P8QueueHealth` | `/api/ops/system-state` (live) |
| 5. Data Truthfulness | `DataTruthfulnessPanel` | `/api/ops/system-state` (live classification) |
| 6. Research / Strategy Layer | `P8RegimeFreshness` (live) + `StrategyResearchPanel` (static, inside the reference group) | mixed, labeled |
| 7. Risk / Execution Safety | `RiskExecutionSafetyPanel` | `/api/ops/system-state` (live) + code-level facts |
| 8. What Needs Attention | `AttentionPanel` | Generated from automated checks in `lib/ops/systemState.ts` |
| — Paper Trading | `PaperTradingPanel` | Persisted simulated positions (real data, simulated fills) |
| — Architecture Reference | `ArchitectureReference` | Static, explicitly bannered |
| 9. How to Read This Dashboard | `HowToReadPanel` | Static glossary |

All live sections are fed by **one** polling client (`SystemStateConsole`,
20s interval) hitting `GET /api/ops/system-state`.

## The system-state endpoint

`GET /api/ops/system-state` composes the existing read-only summaries:

- `loadP8OpsSummary` (`lib/ops/p8Summary.ts`) — scheduler, worker, queue,
  pipeline stages, snapshot and regime freshness, readiness checklist
- `loadRiskGateSummary` (`lib/ops/riskGateSummary.ts`) — risk decisions and
  trade intents

into a `SystemStateResponse` (`lib/ops/systemState.ts`): a conceptual flow
map, a prioritized attention list, and a data-truthfulness classification.

Unlike `/api/ops/p8`, this route **never returns 503**. Unavailability is part
of the state: if the database or a summary cannot be read, the response says
so (`ops.available = false` with a reason) and every derived status degrades
to `unknown`. The dashboard renders that honestly instead of hiding it.

## Data honesty rules

These are enforced by construction and covered by `npm run smoke:system-state`:

1. **No fake green.** A stage is `healthy` only when its last scheduled run
   succeeded within the freshness window (2h for an hourly pipeline).
2. **Unknown is never healthy.** If a state cannot be determined, it renders
   as `unknown` with the reason. `unknown` stages never claim real data.
3. **Static content is labeled.** Hand-written design/research panels live
   behind the "Static Reference" banner and are classified `static` in the
   truthfulness panel. They never carry live-looking status.
4. **Stale is visible.** Snapshots past expiry and regimes past the freshness
   window are shown as `stale`, and raise attention items.
5. **Live execution is always reported disabled.** This is a code-level fact
   (`FORBIDDEN_LIVE_JOB_TYPES` rejected at the job store layer), reported in
   every response regardless of database availability.
6. **No new paid dependencies, no OpenAI requirement.** The dashboard renders
   fully without `OPENAI_API_KEY`. Header tickers are labeled display-only.

## Validation

```
npx tsc --noEmit
npm run build
npm run smoke:system-state    # composition + honesty invariants (offline)
npm run smoke:p8-ops-dashboard # existing ops summary checks
```
