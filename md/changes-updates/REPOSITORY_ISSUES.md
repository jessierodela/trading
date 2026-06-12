# Repository Issues — Outstanding Work

**Generated:** 2026-05-29
**Last revised:** 2026-06-11 (P7A merged via PR #4 — Tier 1 #2 fully resolved)
**Source:** Code review of `main` (HEAD `d1599bc`) against `md/ai-instructions/QUANT_DESK_CONVERSION_PLAN.md` (dated 2026-05-13).

This document captures the concrete, file-cited gaps between the current codebase and the lightweight quant desk target. Items are tiered by impact, not by plan priority — Tier 1 blocks production, Tier 5 is research debt. Each item names the file or directory it lives in, the symptom, and what done looks like.

A spreadsheet view of the same data lives at `QUANT_DESK_STATUS.xlsx` (in OneDrive). When this file and the spreadsheet disagree, this file wins.

---

## What changed on 2026-06-11

Six commits + one PR. First five landed direct-to-main (recurring pattern); the sixth went through PR #4 — the first PR-discipline merge of the day.

| SHA | Subject | Route | Effect on this document |
|---|---|---|---|
| `ee9ba1e` | Harden P5 research for risk readiness | Direct push | Tier 5 prep |
| `f89e277` | Build deterministic P6A risk engine core | Direct push | **Closes Tier 1 #1.** Bumps `RISK_VERSION`. |
| `6c70111` | Make P6A stop fallback explicit | Direct push | Hardens Tier 1 #1. |
| `1c1724e` | Add optional P6B risk backtest overlay | Direct push | New section: backtest-side integration. |
| `b4f5e54` | Add P6C trade intent simulation layer | Direct push | Closes intent-layer half of Tier 1 #2. |
| `b86e96d` → `d1599bc` | Add P7A paper trading core | **PR #4** (merged with approval body) | **Fully closes Tier 1 #2.** Adds `lib/execution/*`. |

Net: Tier 1 went from 3 hard blockers (risk / paper broker / jobs) to **1 hard blocker (jobs queue) + 2 wire-up follow-ups**.

---

## Tier 1 — Production blockers

### ~~1. No risk layer~~ — RESOLVED 2026-06-11

**Resolved by:** commits `f89e277` (core) and `6c70111` (stop fallback).
**Now lives at:**
- `lib/risk/riskEngine.ts` (214 lines) — entrypoint
- `lib/risk/types.ts` (73 lines) — `RiskInput`, `RiskDecision`, `RiskConfig`, `RiskPositionSide`
- `lib/risk/positionSizing.ts` (66 lines) — equity-aware sizing
- `lib/risk/stops.ts` (54 lines) — stop/target derivation with explicit fallback
- `lib/risk/killSwitch.ts` (108 lines) — manual + automatic kill conditions
- `lib/risk/riskInputAdapter.ts` (30 lines) — adapter from external state
- `_smoke/risk.ts` (342 lines) — smoke coverage via `npm run smoke:risk`

`RISK_VERSION` bumped from the stub to `"risk.2026-06-11.v1"` in `lib/versions.ts:163`.

Block-reason table in `riskEngine.ts` covers 24 conditions (signal validity, account equity, stops, cooldowns, exposure caps per-symbol and portfolio, leverage, daily/weekly loss caps, consecutive losses, open-position drawdown, regime reliability collapse, NEWS_SHOCK, regime block, long/short disable, kill switch, regime size block). This is broader than the plan's v1 list.

**Remaining follow-up:** the risk engine exists in isolation. It is not yet wired into the live `/api/cache/refresh` path (live agents still don't generate risk-checked intents). See follow-up item below.

### ~~2. No execution layer~~ — RESOLVED 2026-06-11 (via PR #4)

**Resolved by:** PR #4 (commit `b86e96d`, merged into main as `d1599bc`) plus the earlier `b4f5e54` intent layer.

**Trade intent scaffolding (b4f5e54):**
- `lib/tradeIntent/createTradeIntent.ts` (74 lines) — pure factory taking a `StrategySignal` + `RiskDecision`
- `lib/tradeIntent/types.ts` (57 lines) — full 9-state status enum: `created | risk_rejected | risk_approved | submitted | filled | partially_filled | cancelled | closed | error`
- `lib/tradeIntent/tradeIntentStore.ts` (54 lines) — `TradeIntentStore` interface + `InMemoryTradeIntentStore`
- `lib/tradeIntent/index.ts` — re-exports
- `_smoke/tradeIntent.ts` (199 lines)

**Paper broker (PR #4):**
- `lib/execution/paperBroker.ts` (122 lines) — paper orders only created from risk-approved trade intents; rejected/expired/cancelled intents blocked; kill switch blocks new orders
- `lib/execution/paperPosition.ts` (140 lines) — long/short stop-loss + take-profit; PnL, fee, slippage accounting; manual close; explicit (not daemonized) monitoring
- `lib/execution/orderManager.ts` (62 lines) — order state machine
- `lib/execution/fillSimulator.ts` (23 lines) — deterministic fills; explicit supplied prices only
- `lib/execution/types.ts` (90 lines) — domain types
- `lib/execution/index.ts` (18 lines) — re-exports
- `_smoke/paperTrading.ts` (263 lines) — `npm run smoke:paper-trading`

**Lineage chain now complete:** signal → strategy → risk decision → trade intent → paper order → fill → paper position, with metadata threaded end-to-end.

**Remaining follow-up:** still no `/api/orders/paper` or `/api/positions` route, no DB migration (in-memory storage only), and no live broker/exchange wiring. Those are out of P7A scope by design — see follow-up #2F below for the persistence half and #2G (new) for the API surface.

### 3. Refresh pipeline is synchronous and memory-only

**Where:** `app/api/cache/refresh/route.ts:40` (imports `memCache`), `:260` (writes to `memCache`).
**Symptom:** Full pipeline (TAAPI fetches → 6 GPT agents → confluence → narrative) runs inside one HTTP request and writes to in-process memory. Cold starts wipe state. TAAPI rate-limit sleeps live inside the request. No retry, no job ID, no failure log. Telegram webhook calls the same path.
**Plan reference:** Priority 8, Phase 6.
**Done looks like:** `jobs` table exists (`0002_jobs.sql`); a worker process claims jobs; `/api/cache/refresh` enqueues and returns a job ID; dashboard shows last successful run + stale-data warnings; failed jobs visible with errors.

---

## Tier 1 follow-ups (new today)

### 1F. Wire risk engine into the live signal path

**Symptom:** `lib/risk/riskEngine.ts` exists but `app/api/cache/refresh/route.ts` does not call it. The agents currently emit signals that bypass risk entirely. Smoke tests prove the engine works in isolation; the live path doesn't use it.
**Done looks like:** every emitted `StrategySignal` (or live agent decision earmarked as actionable) is fed to `riskEngine.decide(...)`; intents are persisted via a `TradeIntent`; the dashboard surfaces the risk decision (approved vs rejected vs blocked) per signal.

### 2F. Persist trade intents + orders + fills + positions to Postgres

**Symptom:** After PR #4, the entire trade lineage exists in-memory only. `InMemoryTradeIntentStore`, the order manager, the fill simulator, and `paperPosition` state all live in process memory. The schema's `trade_intents`, `orders`, `fills`, and `positions` tables have been empty since P2. A worker restart loses everything.
**Done looks like:** `PostgresTradeIntentStore`, `PostgresOrderStore`, `PostgresFillStore`, `PostgresPositionStore` each `implement` the corresponding interface; rows carry `source_signal_ids`, `risk_decision` JSONB, status transitions; smoke tests cover round-trip read/write for each.

### 2G. API surface for paper trading (NEW post-PR #4)

**Symptom:** PR #4 deliberately ships no API routes. Plan calls for `/api/orders/paper` and `/api/positions`. Without these, the dashboard cannot read paper-trading state and Telegram cannot publish fills.
**Done looks like:** Next.js routes under `app/api/orders/paper/route.ts` and `app/api/positions/route.ts` read from the Postgres stores (depends on #2F); execution dashboard panel renders live positions and PnL.

---

## Tier 2 — Silent correctness and data-quality risks

### 4. Two indicator pipelines coexist; the live path uses the old one

**Where:**
- New (validated): `lib/features/engine.ts`, FEATURE_VERSION `features.2026-05-20.v3`, cross-validated against TAAPI in PR #2.
- Old (still authoritative for live): `lib/indicatorCache.ts`, `lib/taapi.ts`, `lib/taapi1d.ts`, consumed by `app/api/cache/refresh/route.ts`.

**Symptom:** Research and backtests read from `feature_snapshots`. Live dashboard reads from TAAPI. The two paths can drift on math or timing.
**Done looks like:** `/api/cache/refresh` reads from `feature_snapshots`; deterministic strategies replace the agents as the trade-signal source; TAAPI reduced to optional debug/comparison.

### 5. Mixed canonical symbols

**Where:** `lib/indicatorCache.ts:254` overrides volume with `yahoo-finance2` session volume while RSI/MACD come from TAAPI on Binance. `lib/agents/meanReversion.ts:305` and `lib/agents/regimeDetector.ts:477` reference the pattern.
**Symptom:** TAAPI reports `BTC/USDT` (Binance). Yahoo reports `BTC-USD`. Volume and close can disagree by enough to flip a signal. No `lib/data/symbolMap.ts`.
**Plan reference:** Priority 9.
**Done looks like:** `lib/data/symbolMap.ts` exists; one canonical symbol per asset; storage validators reject mismatched-source rows.

### 6. GPT outputs validated by `JSON.parse(clean)` only

**Where:** Six agents do this manually — `breakoutWatcher:228`, `meanReversion:237`, `momentumScout:319`, `regimeDetector:537`, plus `trendFollower` and `volatilityArbiter`.
**Symptom:** Malformed JSON crashes the request. No retry, no raw-response persistence, no schema enforcement. `zod` is not a direct dependency.
**Plan reference:** Priority 10.
**Done looks like:** `zod` added; `lib/agents/schemas.ts` exports one schema per agent; retry once on invalid; persist raw + parse error + `prompt_version` + `model_version` to `agent_outputs`.

### 7. No outcome tracking

**Where:** No `signal_outcomes` table in `migrations/0001_initial_schema.sql`. No `jobs/evaluateSignalOutcomes.ts`. No grep hits anywhere.
**Symptom:** P5 research measures simulated backtest PnL, not live signal PnL. Dashboard cannot show "A1 BUY signals over the last 30 days returned X%."
**Plan reference:** Priority 12.
**Done looks like:** Migration `0003_signal_outcomes.sql`; periodic job populates `return_1h`, `return_4h`, `return_12h`, `return_24h`, `MFE`, `MAE`, `hit_stop_before_target`, `regime_at_signal`, `regime_after_24h`; dashboard surfaces rolling outcome stats.

---

## Tier 3 — Process and repository hygiene

### 8. PR discipline mixed — first PR-merge of the day is a precedent

**Symptom:** Today's first 5 commits (P5 risk-readiness, P6A core, stop fallback, P6B overlay, P6C intent layer) all landed on `main` directly without a PR — same pattern as P3, P4, the dashboard rebuild, and the May P5 work. **PR #4 (P7A paper trading core) broke the pattern** — first PR-merge for non-Phase-2 work and the first time the Claude Code GitHub Actions workflow had a chance to run. PR count: **#1, #2, #3, #4**.
**Implication:** The PR-less pattern is no longer 100% — but enforcement is still social rather than mechanical. Without branch protection, the next phase can silently revert.
**Done looks like:** Branch protection on `main` requiring PR + green CI before merge. Make the PR-less direct push impossible.

### ~~9. Today's merged branches still on remote~~ — RESOLVED 2026-06-11

**Cleaned up in two rounds today:**
- Round 1 (after the direct-push spree): `git push origin --delete ai/p5-priority-9-final-report-quality ai/p5-risk-readiness-hardening ai/p6-risk-engine-core ai/p6-risk-overlay-backtest ai/p6-trade-intent-simulation` (5 branches).
- Round 2 (after PR #4): `ai/p7-paper-trading-core` auto-deleted via `gh pr merge --delete-branch`.

Origin and local clone now show only `main`. Item #15 in Pending Work tracks the long-term fix (branch protection) so this cleanup loop stops recurring.

### 10. `activeAsset` branch pruning (historical) — closed

Was pruned mid-review on 2026-05-26. No record in main. Leaving as historical note.

---

## Tier 4 — Small code-level smells

### 11. `lib/polygon.ts` is named after the wrong provider

**Where:** `lib/polygon.ts`.
**Symptom:** File uses `yahoo-finance2`. Misleading filename + imports.
**Done looks like:** Renamed to `lib/market/yahooQuotes.ts`; imports updated.

### 12. `next` is pinned at `15.5.18` with no `npm audit` record

**Where:** `package.json:31`.
**Symptom:** Plan's P0.5 was "Upgrade Next.js + clear npm audit." 2026-05-13 audit recorded 1 critical / 2 high / 2 moderate. No audit log committed since.
**Done looks like:** `npm audit` output committed or addressed in a CI gate.

### 13. `lib/confluence/*` labeled LEGACY but still authoritative

**Where:** `lib/confluence/scoreSignals.ts:1-7` and `lib/confluence/confluenceEngine.ts:1-43`.
**Symptom:** Transition notes point at `lib/strategies/arbitrator.ts` — that file does not exist. The "legacy" code is also the live path.
**Done looks like:** Either build `arbitrator.ts` and migrate consumers, or remove the deprecation note and document confluence as the current production path with no planned successor.

### ~~14. `RISK_VERSION = "risk.v1"` is a misleading stub~~ — RESOLVED 2026-06-11

`RISK_VERSION` now `"risk.2026-06-11.v1"` per commit `f89e277`. CHANGELOG line in `lib/versions.ts` documents the bump. Real risk engine in place; the stamp is honest.

---

## Tier 5 — Open research debt

### 15. P5 router validation came back negative on all 5 crypto assets

**Where:** `P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md`, walk-forward sections; refined per-asset reports under `reports/p5/` including the 2026-06-02 priority-9 finalized version.
**Symptom:** OOS verdict `NOT VALIDATED` on BTC, ETH, SOL, LINK, AVAX — 0/3 folds. Refined variants are the in-flight response. Today's `ee9ba1e` "Harden P5 research for risk readiness" hardens the research path but does not flip the verdict.
**Implication:** **Do not move to paper trading until at least one variant validates.** Otherwise you paper-trade noise.
**Done looks like:** At least one refined variant documented as PASS across 3/3 folds on at least one asset; verdict captured in `reports/p5/`.

### 16. Strategy registry doubled 4→8 after PR #3 — still applies

**Where:** `lib/strategies/strategyRegistry.ts` spreads `REFINED_STRATEGY_VARIANTS`.
**Symptom:** Five call sites iterate the full registry. After PR #3 they see 8 strategies, including refined-but-not-validated variants. Risk engine adds a second gate (block-on-not-validated), but the registry split itself is still unimplemented.
**Done looks like:** `STRATEGY_REGISTRY_LIVE` (subset, validated only) vs `STRATEGY_REGISTRY_RESEARCH` (full), or a `production: boolean` flag on `StrategyDefinition`; live routes filter accordingly.

---

## Mapping back to the plan

| Plan priority             | Tier | Item(s)                                                   |
|---------------------------|------|-----------------------------------------------------------|
| P0.5  npm audit           | 4    | #12                                                       |
| P6    Risk engine         | 1    | **#1 RESOLVED**, follow-up #1F still open                 |
| P7    Paper trading       | 1    | **#2 RESOLVED** (via PR #4), follow-ups #2F + #2G open    |
| P8    Jobs queue          | 1    | #3                                                        |
| P9    Data quality        | 2    | #5                                                        |
| P10   Zod schemas         | 2    | #6                                                        |
| P11   Versioning          | 4    | **#14 RESOLVED**                                          |
| P12   Outcome tracking    | 2    | #7                                                        |
| Folder structure          | —    | lib/risk + lib/tradeIntent + lib/execution all present    |
| Live cutover off TAAPI    | 2    | #4                                                        |
| API route revisions       | 4    | #11, #13                                                  |
| PR discipline             | 3    | #8 (item #9 RESOLVED 2026-06-11)                          |
| P5 research               | 5    | #15, #16                                                  |

## Suggested execution order (revised 2026-06-11 post-PR #4)

1. **#15 first** — confirm at least one refined variant validates OOS. Today's `ee9ba1e` hardened the research path but the OOS verdict has not moved.
2. **#16 + #1F + #2F together** — registry split (live vs research) + wire risk engine into live signal path + persist trade intents/orders/fills/positions to Postgres. These three unlock the safe path from research to paper.
3. **#2G** — add `/api/orders/paper` and `/api/positions` routes; surface positions/PnL on the dashboard. Depends on #2F.
4. **#3 (jobs queue)** — once the live pipeline carries risk + intents, the synchronous `/api/cache/refresh` route becomes the biggest fragility. Move to queue.
5. **#6 (zod), #7 (outcomes), #4 + #5 (TAAPI cutover + canonical symbol)** — in parallel during the execution build.
6. **Tier 4 cleanup (#11, #12, #13)** — fold into whatever PR is open.
7. **#8 (branch protection)** — make the PR-less direct-push pattern impossible before any live deployment. PR #4 sets the precedent; protection makes it the rule.
