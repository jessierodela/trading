# Repository Issues — Outstanding Work

**Generated:** 2026-05-29
**Source:** Code review of `main` (HEAD `03f341d`) and `ai/p5-research-expansion` (HEAD `4905d7c`) against `md/ai-instructions/QUANT_DESK_CONVERSION_PLAN.md` (dated 2026-05-13).

This document captures the concrete, file-cited gaps between the current codebase and the lightweight quant desk target. Items are tiered by impact, not by plan priority — Tier 1 blocks production, Tier 5 is research debt. Each item names the file or directory it lives in (or that it needs to live in), the symptom, and what done looks like.

A spreadsheet view of the same data lives at `QUANT_DESK_STATUS.xlsx` (in OneDrive). When this file and the spreadsheet disagree, this file wins.

---

## Tier 1 — Production blockers

These prevent any move from "research desk" to "trading desk." Address before paper trading.

### 1. No risk layer

**Where:** `lib/risk/` does not exist.
**Symptom:** `lib/versions.ts:140` declares `RISK_VERSION = "risk.v1"` with the comment *"Stub. Real risk engine ships in P6."* Nothing in the codebase calls into risk because there is nothing to call. No position sizing, no daily-loss cap, no consecutive-loss cooldown, no kill switch, no exposure ceiling.
**Plan reference:** Priority 6, Phase 5.
**Done looks like:** `lib/risk/{types,riskEngine,positionSizing,killSwitch}.ts` exist; every trade intent calls `riskEngine.decide(input) → RiskDecision` before persisting; v1 rules (max risk per trade 0.25–0.50%, max daily loss 1.0–2.0%, block on `NEWS_SHOCK`, reduce in `HIGH_VOL`, reject without invalidation, cooldown after N losses) covered by tests; `RISK_VERSION` bumped from the stub.

### 2. No execution layer

**Where:** `lib/execution/` does not exist.
**Symptom:** Schema migration `migrations/0001_initial_schema.sql` created `trade_intents`, `orders`, `fills`, and `positions` back in Phase 2 — those tables have been empty since. No paper broker, no order manager, no fill simulator, no position lifecycle writer.
**Plan reference:** Priority 7, Phase 5.
**Done looks like:** `lib/execution/{paperBroker,orderManager,fillSimulator,types}.ts` exist; `/api/orders/paper` and `/api/positions` routes ship; every trade row links to its source signal, regime snapshot, feature snapshot, and risk decision; 30 days of continuous paper trading recorded before any live exchange wiring.

### 3. Refresh pipeline is synchronous and memory-only

**Where:** `app/api/cache/refresh/route.ts:40` (imports `memCache`), `:260` (writes to `memCache`).
**Symptom:** The full pipeline (TAAPI fetches → 6 GPT agents → confluence → narrative) runs inside one HTTP request and writes to in-process memory. Cold starts wipe state. TAAPI rate-limit sleeps live inside the request. There is no retry, no job ID, no failure log, no "fire and forget." The Telegram webhook calls the same path.
**Plan reference:** Priority 8, Phase 6.
**Done looks like:** A `jobs` table exists (migration `0002_jobs.sql`); a worker process (Inngest, QStash, Supabase Edge, or a small VPS) claims jobs; `/api/cache/refresh` enqueues and returns a job ID; the dashboard shows last successful run and stale-data warnings; failed jobs are visible with their errors.

---

## Tier 2 — Silent correctness and data-quality risks

These do not crash anything but quietly corrupt research and live decisions.

### 4. Two indicator pipelines coexist; the live path uses the old one

**Where:**
- New (validated): `lib/features/engine.ts`, `lib/features/indicators.ts`, FEATURE_VERSION `features.2026-05-20.v3`, cross-validated against TAAPI in PR #2 (P2D GO).
- Old (still authoritative for live): `lib/indicatorCache.ts`, `lib/taapi.ts`, `lib/taapi1d.ts`, consumed by `app/api/cache/refresh/route.ts`.

**Symptom:** Research and backtests read from `feature_snapshots` (good). The live dashboard reads from TAAPI (legacy). The two paths can drift on math or timing, and nothing enforces parity. `lib/versions.ts` already labels the old path `DATA_SOURCE_TAAPI_LEGACY = "taapi.legacy"`, so intent is documented — but no code respects the label.

**Done looks like:** `/api/cache/refresh` reads from `feature_snapshots`; the deterministic strategies run instead of the agents for trade signals; TAAPI is reduced to optional debug/comparison; `lib/indicatorCache.ts` and `lib/taapi*.ts` either deleted or moved to a `legacy/` namespace.

### 5. Mixed canonical symbols

**Where:** `lib/indicatorCache.ts:254` overrides volume with `yahoo-finance2`'s session volume while RSI/MACD continue to come from TAAPI on Binance. `lib/agents/meanReversion.ts:305` and `lib/agents/regimeDetector.ts:477` reference the same pattern.

**Symptom:** TAAPI reports `BTC/USDT` on Binance. Yahoo reports `BTC-USD`. They are different instruments on different exchanges. Volume and close can disagree by enough to flip a signal. There is no `lib/data/symbolMap.ts` to normalize.

**Plan reference:** Priority 9.
**Done looks like:** `lib/data/symbolMap.ts` exists and is the only place that maps display symbols to exchange-specific tickers; one canonical symbol per asset (recommendation per plan: BTC/USDT on Binance OR BTC/USD on Coinbase/Kraken); storage validators reject rows whose source disagrees with the canonical mapping.

### 6. GPT outputs validated by `JSON.parse(clean)` only

**Where:** Six agents do this manually:
- `lib/agents/breakoutWatcher.ts:228`
- `lib/agents/meanReversion.ts:237`
- `lib/agents/momentumScout.ts:319`
- `lib/agents/regimeDetector.ts:537`
- `lib/agents/trendFollower.ts`
- `lib/agents/volatilityArbiter.ts`

**Symptom:** If GPT returns malformed JSON, the agent throws and the whole `/api/cache/refresh` request fails. No retry. No raw-response persistence. No parse-error column. No schema enforcement that fields are the right shape. `zod` is not in `package.json` as a direct dependency (only transitive via Supabase and Next).

**Plan reference:** Priority 10.
**Done looks like:** `zod` added to `dependencies`; `lib/agents/schemas.ts` exports one schema per agent; agents catch parse errors, retry once, then persist raw response + parse error to `agent_outputs`; `prompt_version` and `model_version` columns populated from `lib/versions.ts`.

### 7. No outcome tracking

**Where:** No `signal_outcomes` table exists in `migrations/0001_initial_schema.sql`. No `jobs/evaluateSignalOutcomes.ts` file. No grep hits for `signal_outcomes`, `forward_return`, or `MFE/MAE` anywhere in `lib/`.

**Symptom:** P5 research currently measures *simulated backtest* PnL, not *live signal* PnL. The dashboard cannot show "agent A1 BUY signals over the last 30 days returned X%." The whole feedback loop is missing — which means you cannot detect strategy decay in production.

**Plan reference:** Priority 12.
**Done looks like:** Migration `0003_signal_outcomes.sql` adds the table (or columns on `strategy_signals` / `agent_outputs`); a periodic job populates `return_1h`, `return_4h`, `return_12h`, `return_24h`, `max_favorable_excursion`, `max_adverse_excursion`, `hit_stop_before_target`, `regime_at_signal`, `regime_after_24h`; dashboard surfaces rolling outcome stats.

---

## Tier 3 — Process and repository hygiene

These do not affect correctness today but make every future change harder to audit.

### 8. PR discipline collapsed after PR #2

**Where:** GitHub PR history.
**Symptom:** PR #1 (P2C) and PR #2 (P2D) used the full branch → PR → review → merge-commit flow. After that, four feature branches landed on `main` with no PR:
- `ai/p3-strategy-layer` (entire deterministic strategy layer)
- `ai/p4-backtesting-engine` (entire backtest engine + API; merge commit `8127d56`)
- `ai/dashboard-architecture-rebuild` (dashboard rewrite, 5 commits ending `03f341d`)
- 17 commits of P5 work that landed before `ai/p5-research-expansion` became the active branch

The Claude Code GitHub Actions workflow (added in `449cd21`) runs on PRs only — it has been idle for a month.

**Done looks like:** Every meaningful change goes through a PR. Direct pushes to `main` are blocked via branch protection. CI runs on every PR.

### 9. Merged feature branches still on remote

**Where:** `origin/ai/p2c-feature-engine`, `origin/ai/p2d-cross-validation`, `origin/ai/p3-strategy-layer`, `origin/ai/p4-backtesting-engine`, `origin/ai/dashboard-architecture-rebuild`.

**Symptom:** All five are fully merged into main, 25–40 commits behind. Any new work branched off them would diverge.

**Done looks like:** Branches deleted from `origin`. (Tracked as part of this commit's companion cleanup.)

### 10. `activeAsset` branch was pruned mid-review

**Where:** `origin/activeAsset` existed during the first `git fetch` of this review session and was gone on the second. No record in `main`. No PR. No documented decision.

**Done looks like:** Either a documented reason for the deletion, or — if the work was meaningful — a recovered branch or recorded commit hashes.

---

## Tier 4 — Small code-level smells

Trivial cleanup that future readers will thank you for.

### 11. `lib/polygon.ts` is named after the wrong provider

**Where:** `lib/polygon.ts`.
**Symptom:** The file uses `yahoo-finance2`, not Polygon. Misleading filename and import paths.
**Plan reference:** "API Route Revisions" section.
**Done looks like:** Renamed to `lib/market/yahooQuotes.ts`; all imports updated; no remaining references to `polygon`.

### 12. `next` is pinned at `15.5.18` with no `npm audit` record

**Where:** `package.json:31` and absence of an audit log in `md/changes-updates/`.
**Symptom:** Plan's P0.5 was *"Upgrade Next.js + clear npm audit."* The plan recorded 1 critical / 2 high / 2 moderate vulnerabilities on 2026-05-13. No audit has been run or logged since.
**Done looks like:** `npm audit` output committed to `md/changes-updates/` or addressed in a CI gate; high/critical advisories either patched or explicitly accepted with rationale.

### 13. `lib/confluence/*` labeled LEGACY but still authoritative

**Where:** `lib/confluence/scoreSignals.ts:1-7` and `lib/confluence/confluenceEngine.ts:1-43` carry transition notes saying *"the target is `lib/strategies/arbitrator.ts`."*
**Symptom:** That target file does not exist. Readers are told the code is deprecated but pointed at a destination that has not been built. The legacy code is also the live path.
**Done looks like:** Either `lib/strategies/arbitrator.ts` exists and consumers are migrated, or the transition note is removed and the confluence code is documented as the current production path with no planned successor.

### 14. `RISK_VERSION = "risk.v1"` is a misleading stub

**Where:** `lib/versions.ts:140`.
**Symptom:** The constant is exported. If any persistence path imports and stamps it (currently none do), every row would falsely imply a risk decision was made. Not a current bug — a footgun once Phase 5 starts.
**Done looks like:** Either delete the export until the risk engine ships, or rename to `RISK_VERSION_PENDING = null` so it cannot be stamped accidentally.

---

## Tier 5 — Open research debt

Not code bugs — but they shape what should and should not happen next.

### 15. P5 router validation came back negative on all 5 crypto assets

**Where:** `P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md`, walk-forward sections.
**Symptom:** OOS verdict is `NOT VALIDATED` on BTC, ETH, SOL, LINK, AVAX — 0/3 folds passed. The response (in flight on `ai/p5-research-expansion`) is to refine each base strategy into gated variants and re-test (`lib/strategies/refinement/*`).
**Implication:** The P4/P5 engine has not yet produced a strategy that passes its own out-of-sample bar. **Do not move to paper trading until at least one variant validates.** Otherwise you will paper-trade noise and confirm-bias yourself into live deployment.
**Done looks like:** At least one refined variant has a documented PASS verdict across all 3 walk-forward folds on at least one asset; the verdict is captured in `reports/p5/`.

### 16. Strategy registry doubles when P5 merges

**Where:** `lib/strategies/strategyRegistry.ts` (P5 branch adds `...REFINED_STRATEGY_VARIANTS`).
**Symptom:** Five call sites iterate the full `STRATEGY_REGISTRY`:
- `lib/backtest/portfolioBacktest.ts:60`
- `lib/backtest/regimeValidation.ts:482`
- `lib/strategies/runStrategyWindow.ts:99` (the **live** path)
- `scripts/runExpandedBacktestResearch.ts` (7 places)
- `_smoke/strategies.ts:119` (assertion updated on P5 branch)

After merge, the live `runStrategies()` will emit 2× the signal rows (4 base + 4 refined). That is the intended P5 outcome — but it means refined-but-not-validated variants will start firing in any path that defaults to "all strategies."

**Done looks like:** A `STRATEGY_REGISTRY_LIVE` (subset, validated only) vs `STRATEGY_REGISTRY_RESEARCH` (full) split, or a `production: boolean` flag on `StrategyDefinition`; live routes filter accordingly; only validated strategies reach live or paper trading.

---

## Mapping back to the plan

| Plan priority             | Tier | Item(s) above           |
|---------------------------|------|-------------------------|
| P0.5  npm audit           | 4    | #12                     |
| P6    Risk engine         | 1    | #1                      |
| P7    Paper trading       | 1    | #2                      |
| P8    Jobs queue          | 1    | #3                      |
| P9    Data quality        | 2    | #5                      |
| P10   Zod schemas         | 2    | #6                      |
| P12   Outcome tracking    | 2    | #7                      |
| Folder structure          | —    | #1, #2                  |
| Live cutover off TAAPI    | 2    | #4                      |
| API route revisions       | 4    | #11, #13                |
| Versioning hygiene        | 4    | #14                     |
| Beyond plan: PR discipline| 3    | #8, #9, #10             |
| Beyond plan: P5 research  | 5    | #15, #16                |

## Suggested execution order

1. **#15 first** — confirm at least one refined variant validates OOS. If none do, the whole "ship a desk" plan is premature.
2. **#16** — gate live vs research strategies before any live wiring.
3. **#1 (risk) → #2 (execution) → #3 (jobs)** — the production-blocker trio, in dependency order.
4. **#6 (zod), #7 (outcomes), #4 + #5 (live cutover + canonical symbol)** — in parallel during the risk/execution build.
5. **Tier 4 cleanup** — fold into whatever PR is open at the time.
