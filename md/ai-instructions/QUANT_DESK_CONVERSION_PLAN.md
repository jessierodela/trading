# BTC Pipeline → Lightweight Quant Desk Conversion Plan

**Project reviewed:** `trading-main(1).zip`  
**Review date:** May 13, 2026  
**Current state:** Next.js dashboard with TAAPI/Yahoo market data, GPT-4o signal agents, A6 Regime Detector, weighted Confluence Engine, Telegram webhook, and in-memory signal cache.

---

## Executive Summary

The current codebase is not yet a quant desk. It is a **market signal dashboard** with AI-assisted interpretation. That is a good foundation, but a quant desk needs a deeper operating system around the signals:

```text
market data → feature store → deterministic strategies → backtests → risk engine → paper/live execution → PnL + diagnostics
```

The biggest revision is architectural: stop treating the latest GPT-generated signal as the product. The product should become a **repeatable, testable decision pipeline** where every signal can be replayed, scored, risk-checked, paper-traded, and measured.

The current agents can stay, but they should be demoted from “predictor” to **research/interpretation modules**. Actual trade logic should be deterministic, testable, and versioned.

---

## What Exists Today

### Working pieces

The codebase already has several useful building blocks:

- `lib/indicatorCache.ts` — 1H indicator/quote cache.
- `lib/indicatorCache1d.ts` — 1D indicator cache.
- `lib/taapi.ts` and `lib/taapi1d.ts` — TAAPI indicator fetchers.
- `lib/polygon.ts` — actually uses `yahoo-finance2` for quotes despite the file name.
- `lib/agents/*` — GPT-4o-powered agents:
  - A1 Momentum Scout
  - A2 Breakout Watcher
  - A3 Trend Follower
  - A4 Volatility Arbiter
  - A5 Mean Reversion
  - A6 Regime Detector
- `lib/confluence/*` — deterministic score + GPT narrative.
- `app/api/cache/refresh/route.ts` — runs full refresh pipeline.
- `app/api/regime/refresh/route.ts` — lightweight regime-only endpoint.
- `app/api/regime/[symbol]/route.ts` — cached regime oracle endpoint.
- Dashboard UI showing agents, signals, confluence, stats, and detail panel.
- Telegram webhook that can trigger refresh and return summaries.

### Local validation performed

```bash
npm ci
npx tsc --noEmit
```

TypeScript passed cleanly.

`npm run build` failed because the sandbox could not fetch Google Fonts used by `next/font/google` in `app/layout.tsx`. That failure is environmental/network-related, not a TypeScript failure.

`npm audit` reported 5 vulnerabilities:

- 1 critical
- 2 high
- 2 moderate

The biggest dependency issue is the pinned `next` version. Upgrade Next.js before production deployment.

---

## Core Diagnosis

The current system answers:

> “What do the agents think right now?”

A quant desk must answer:

> “What edge exists, how was it proven, what risk is allowed, what trade would be taken, and how did it perform over time?”

Right now the code has signal generation, but it does **not** yet have:

- Historical market data storage.
- Replayable feature snapshots.
- Backtesting.
- Forward testing.
- Paper trading.
- Trade lifecycle state.
- Position tracking.
- Portfolio/risk management.
- Slippage and fees.
- PnL attribution.
- Strategy versioning.
- Signal outcome analytics.
- Data quality checks.
- Production-grade job scheduling.

That is the difference between a predictor and a lightweight quant desk.

---

# Priority 0 — Stabilize Current Codebase Before Expanding

These changes should be done before adding more intelligence.

## 0.1 Fix A4/A5 UI metadata mismatch

In `config/agents.ts`:

- A4 = `Volatility Arbiter`
- A5 = `Mean Reversion`

But in `components/agents/LiveAgentGrid.tsx`, the metadata is reversed:

- `A4` describes an oversold bounce detector.
- `A5` describes ATR/volatility risk.

### Change needed

Swap the `AGENT_META.A4` and `AGENT_META.A5` descriptions so UI matches runtime behavior.

### Why it matters

This causes dashboard interpretation errors. The system may be logically running correctly while the user sees the wrong explanation for the agent.

---

## 0.2 Move Confluence Engine off raw A6 vote behavior

In `app/api/cache/refresh/route.ts`, all agent signals are flattened:

```ts
const allSignals = agentResults.flatMap((a) => a.signals);
const confluence = await runConfluenceEngine(allSignals);
```

This includes A6 Regime Detector signals. A6 is currently mapped to `watch`, so it scores as zero, but it still appears as an agent vote. The comments say regime reliability should gate downstream signals, but `scoreSignals.ts` does not actually apply regime reliability.

### Change needed

Refactor confluence input into two separate inputs:

```ts
const tradingSignals = agentResults
  .filter((a) => a.id !== "A6")
  .flatMap((a) => a.signals);

const confluence = await runConfluenceEngine(tradingSignals, regimeMap);
```

Update function signature:

```ts
runConfluenceEngine(
  tradingSignals: Signal[],
  regimeMap: Record<string, RegimeContext>
)
```

Then apply regime modifiers inside scoring:

```ts
if (regime === "NEWS_SHOCK") blockTrade();
if (regime === "CHOP") raiseThreshold();
if (reliability < 0.50) blockTrade();
if (regime === "TREND_UP") favorLongOnly();
if (regime === "TREND_DOWN") favorShortOnly();
```

### Why it matters

A6 should not be another vote. It should be a **context gate**.

---

## 0.3 Consolidate regime permission mapping

There are two regime mapping tables:

- `app/api/regime/[symbol]/route.ts`
- `app/api/regime/refresh/route.ts`

They are not identical. Example differences:

- `TREND_UP` size multiplier is `1.0` in one file and `1.25` in the other.
- `LOW_VOL` is `ALLOW_BOTH_SMALL` in one file and `ALLOW_BOTH` in the other.
- `HIGH_VOL` size multiplier differs.

### Change needed

Create one shared file:

```text
lib/regime/permissionMap.ts
```

Export:

```ts
export function mapRegimeToPermission(
  regime: RegimeLabel,
  reliability: number
): RegimeMappingResult
```

Then use that function in both routes.

### Why it matters

The Markov bot and dashboard can currently receive different instructions for the same regime. That creates strategy drift.

---

## 0.4 Replace `next/font/google` dependency or make font local

`npm run build` failed in the sandbox because `app/layout.tsx` imports:

```ts
import { DM_Mono } from "next/font/google";
```

### Change needed

Use a local font or CSS fallback for production reliability.

Option A: keep the font but self-host it.  
Option B: remove `next/font/google` and use a CSS stack:

```css
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

### Why it matters

Production builds should not fail because Google Fonts cannot be fetched.

---

## 0.5 Upgrade Next.js and audit dependencies

`npm audit` showed 5 vulnerabilities, including a critical item tied to Next.js.

### Change needed

Upgrade Next.js and related packages:

```bash
npm install next@latest react@latest react-dom@latest eslint-config-next@latest
npm audit fix
npx tsc --noEmit
npm run build
```

Then retest all routes.

---

# Priority 1 — Reframe the System: From Predictor to Quant Desk

## Current architecture

```text
TAAPI/Yahoo latest data
   ↓
indicator cache
   ↓
GPT agents
   ↓
confluence score + GPT narrative
   ↓
in-memory dashboard cache
   ↓
UI / Telegram / regime endpoint
```

## Target architecture

```text
exchange market data
   ↓
raw bar store
   ↓
feature engine
   ↓
feature snapshot store
   ↓
regime detector
   ↓
strategy engines
   ↓
confluence / signal arbitration
   ↓
risk engine
   ↓
paper/live order manager
   ↓
positions, fills, PnL, analytics
   ↓
research dashboard + alerting
```

## Core rule

LLMs can explain, classify, and summarize. They should **not** be the sole source of trading decisions.

Use deterministic strategies for decisions. Use GPT for:

- Natural-language summaries.
- Research notes.
- Setup classification labels.
- Anomaly explanation.
- Post-trade review.

---

# Priority 2 — Add Persistent Data Layer

The current `memCache` in `lib/signalsCache.ts` is not enough. It disappears on cold starts and cannot support research, replay, or auditability.

## Add Supabase/Postgres tables

### `market_bars`

Stores raw OHLCV candles.

```sql
create table market_bars (
  id bigserial primary key,
  symbol text not null,
  exchange text not null,
  timeframe text not null,
  ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric,
  source text not null,
  inserted_at timestamptz default now(),
  unique(symbol, exchange, timeframe, ts)
);
```

### `feature_snapshots`

Stores calculated indicators and derived fields per bar.

```sql
create table feature_snapshots (
  id bigserial primary key,
  symbol text not null,
  timeframe text not null,
  ts timestamptz not null,
  features jsonb not null,
  feature_version text not null,
  inserted_at timestamptz default now(),
  unique(symbol, timeframe, ts, feature_version)
);
```

### `regime_snapshots`

Stores regime classification and the raw feature context used to classify it.

```sql
create table regime_snapshots (
  id bigserial primary key,
  symbol text not null,
  ts timestamptz not null,
  regime text not null,
  reliability numeric not null,
  directional_bias text not null,
  trade_permission text not null,
  edge_multiplier numeric not null,
  size_multiplier numeric not null,
  reason text,
  model_version text,
  prompt_version text,
  feature_version text,
  raw_response jsonb,
  inserted_at timestamptz default now()
);
```

### `strategy_signals`

Stores deterministic strategy outputs.

```sql
create table strategy_signals (
  id bigserial primary key,
  symbol text not null,
  timeframe text not null,
  ts timestamptz not null,
  strategy_id text not null,
  strategy_version text not null,
  direction text not null,
  signal_type text not null,
  confidence numeric not null,
  expected_edge numeric,
  invalidation_price numeric,
  metadata jsonb,
  inserted_at timestamptz default now(),
  unique(symbol, timeframe, ts, strategy_id, strategy_version)
);
```

### `trade_intents`

Stores the risk-approved or risk-rejected trade idea.

```sql
create table trade_intents (
  id bigserial primary key,
  symbol text not null,
  ts timestamptz not null,
  source_signal_ids bigint[] not null,
  direction text not null,
  status text not null,
  entry_logic text,
  stop_loss numeric,
  take_profit numeric,
  suggested_size numeric,
  max_risk_usd numeric,
  risk_decision jsonb,
  inserted_at timestamptz default now()
);
```

### `orders`

```sql
create table orders (
  id bigserial primary key,
  trade_intent_id bigint references trade_intents(id),
  symbol text not null,
  exchange text not null,
  side text not null,
  order_type text not null,
  quantity numeric not null,
  limit_price numeric,
  status text not null,
  external_order_id text,
  submitted_at timestamptz,
  updated_at timestamptz default now()
);
```

### `fills`

```sql
create table fills (
  id bigserial primary key,
  order_id bigint references orders(id),
  symbol text not null,
  side text not null,
  quantity numeric not null,
  price numeric not null,
  fee numeric,
  filled_at timestamptz not null,
  raw jsonb
);
```

### `positions`

```sql
create table positions (
  id bigserial primary key,
  symbol text not null,
  status text not null,
  direction text not null,
  quantity numeric not null,
  avg_entry numeric not null,
  stop_loss numeric,
  take_profit numeric,
  opened_at timestamptz not null,
  closed_at timestamptz,
  realized_pnl numeric,
  metadata jsonb
);
```

### `backtest_runs`

```sql
create table backtest_runs (
  id bigserial primary key,
  strategy_id text not null,
  strategy_version text not null,
  symbol text not null,
  timeframe text not null,
  start_ts timestamptz not null,
  end_ts timestamptz not null,
  config jsonb not null,
  metrics jsonb not null,
  created_at timestamptz default now()
);
```

### `backtest_trades`

```sql
create table backtest_trades (
  id bigserial primary key,
  backtest_run_id bigint references backtest_runs(id),
  symbol text not null,
  direction text not null,
  entry_ts timestamptz not null,
  entry_price numeric not null,
  exit_ts timestamptz,
  exit_price numeric,
  quantity numeric,
  pnl numeric,
  pnl_pct numeric,
  reason_entered text,
  reason_exited text,
  metadata jsonb
);
```

---

# Priority 3 — Replace Third-Party Indicator Dependency with Local Feature Engine

TAAPI is useful for prototyping but not ideal for a quant desk because:

- It is rate-limited.
- It introduces long waits inside API routes.
- It is hard to replay exactly.
- It does not give full candle history.
- It caused the volume SMA issue already noted in the code.

## New approach

Use an exchange or data provider for OHLCV candles, then calculate indicators locally.

### Recommended data flow

```text
exchange OHLCV candles
   ↓
market_bars table
   ↓
featureEngine.ts calculates RSI, MACD, EMAs, ATR, BB, volume metrics
   ↓
feature_snapshots table
```

## New files to create

```text
lib/quant/types.ts
lib/data/marketDataProvider.ts
lib/data/barStore.ts
lib/features/indicators.ts
lib/features/featureEngine.ts
lib/features/featureStore.ts
```

## Core TypeScript contracts

```ts
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";
export type Direction = "long" | "short" | "flat";

export interface Bar {
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface FeatureSnapshot {
  symbol: string;
  timeframe: Timeframe;
  ts: string;
  close: number;
  rsi14?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  macdHist?: number | null;
  ema20?: number | null;
  ema50?: number | null;
  ema200?: number | null;
  atr14?: number | null;
  atrPct?: number | null;
  bbUpper?: number | null;
  bbMiddle?: number | null;
  bbLower?: number | null;
  bbWidth?: number | null;
  relativeVolume20?: number | null;
  distanceFromEma20Atr?: number | null;
  candleRangeAtr?: number | null;
  featureVersion: string;
}
```

## Why this matters

A quant desk must be able to say:

> “Run Strategy X on BTC 1H from January 2022 through today using feature version 1.4 and report performance.”

The current TAAPI latest-bar flow cannot do that.

---

# Priority 4 — Build Strategy Layer Separate from Agents

Right now each GPT agent returns a `Signal`. That is not enough for execution.

Add a deterministic strategy layer.

## New files

```text
lib/strategies/types.ts
lib/strategies/strategyRegistry.ts
lib/strategies/momentumContinuation.ts
lib/strategies/meanReversionBounce.ts
lib/strategies/breakoutExpansion.ts
lib/strategies/trendPullback.ts
```

## Strategy output contract

```ts
export interface StrategySignal {
  symbol: string;
  timeframe: Timeframe;
  ts: string;
  strategyId: string;
  strategyVersion: string;
  direction: "long" | "short" | "none";
  signalType: "setup" | "trigger" | "exit" | "invalidated";
  confidence: number;       // 0-1
  expectedEdge?: number;    // optional until backtested
  invalidationPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  features: FeatureSnapshot;
  reasons: string[];
}
```

## Initial strategies to implement

### 1. Momentum continuation

Uses:

- Price above EMA20.
- EMA20 slope positive.
- MACD histogram positive and expanding.
- RSI between 50 and 70.
- ATR not extreme.
- Regime not `CHOP` or `NEWS_SHOCK`.

### 2. Pullback to support

Uses:

- Daily trend bullish.
- 1H price near EMA20.
- RSI cooled into 40–50.
- MACD histogram still positive or improving.
- Stop below swing low or ATR-based invalidation.

### 3. Breakout expansion

Uses:

- BB width compression followed by expansion.
- Close above upper band.
- Volume confirmation.
- ATR expansion not excessive.

### 4. Mean reversion bounce

Uses:

- RSI below 30 or rising from sub-35.
- Price stretched below EMA20 by ATR multiple.
- MACD histogram improving.
- Position size reduced because countertrend.

## Important rule

The GPT agents can classify and narrate these setups, but the deterministic strategy must decide whether a setup exists.

---

# Priority 5 — Add Backtesting Engine

Without backtesting, the system is still vibes plus indicators.

## New files

```text
lib/backtest/types.ts
lib/backtest/backtestEngine.ts
lib/backtest/metrics.ts
lib/backtest/slippage.ts
lib/backtest/reportStore.ts
app/api/backtests/run/route.ts
app/api/backtests/[id]/route.ts
```

## Backtest engine requirements

The first version does not need to be perfect. It needs to be honest and repeatable.

Minimum features:

- Load historical bars from `market_bars`.
- Calculate/retrieve features at each bar.
- Run one or more strategy modules.
- Apply regime gating.
- Apply risk engine.
- Simulate entries/exits.
- Include fees.
- Include slippage.
- Store metrics.
- Store every simulated trade.

## Metrics to calculate

```text
Total return
CAGR if long enough history exists
Max drawdown
Win rate
Average winner
Average loser
Profit factor
Sharpe approximation
Sortino approximation
Exposure time
Number of trades
Average hold time
Best trade
Worst trade
Consecutive losses
Regime-specific performance
Time-of-day performance
```

## Minimum acceptance criteria

Before paper trading, the system should be able to answer:

- Does the strategy make money after fees?
- Does it only work in one market regime?
- Does it collapse in chop?
- Is performance driven by one or two lucky trades?
- What is the expected drawdown?
- What is the average losing streak?
- What settings are overfit?

---

# Priority 6 — Add Risk Engine Before Execution

Do not connect live execution until this exists.

## New files

```text
lib/risk/types.ts
lib/risk/riskEngine.ts
lib/risk/positionSizing.ts
lib/risk/killSwitch.ts
```

## Risk engine input

```ts
export interface RiskInput {
  signal: StrategySignal;
  regime: RegimeContext;
  accountEquity: number;
  openPositions: Position[];
  recentPnL: PnlSnapshot[];
  config: RiskConfig;
}
```

## Risk decision output

```ts
export interface RiskDecision {
  approved: boolean;
  reason: string;
  sizeMultiplier: number;
  maxRiskUsd: number;
  positionSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  blockedBy: string[];
}
```

## Risk rules for v1

```text
Max account risk per trade: 0.25% to 0.50%
Max daily loss: 1.0% to 2.0%
Max open BTC exposure: configurable
Block trading during NEWS_SHOCK
Reduce size in HIGH_VOL
Reduce or block in CHOP
Require stop-loss for every trade intent
Reject trades with no invalidation level
Reject stale signals
Reject duplicate direction entries within cooldown window
Pause after N consecutive losses
```

## Why this matters

The current system can generate a bullish read, but it has no understanding of:

- Account risk.
- Current exposure.
- Drawdown.
- Loss limits.
- Trade invalidation.
- Volatility-adjusted sizing.

That gap is the main difference between an alert tool and a desk.

---

# Priority 7 — Add Paper Trading Before Live Trading

## New files

```text
lib/execution/types.ts
lib/execution/paperBroker.ts
lib/execution/orderManager.ts
lib/execution/fillSimulator.ts
app/api/orders/paper/route.ts
app/api/positions/route.ts
```

## Order lifecycle

```text
strategy signal
   ↓
trade intent
   ↓
risk approval
   ↓
paper order
   ↓
fill simulation
   ↓
position opened
   ↓
position monitored
   ↓
exit condition
   ↓
position closed
   ↓
PnL stored
```

## Execution states

```ts
export type TradeIntentStatus =
  | "created"
  | "risk_rejected"
  | "risk_approved"
  | "submitted"
  | "filled"
  | "partially_filled"
  | "cancelled"
  | "closed"
  | "error";
```

## Paper trading acceptance criteria

Before any live exchange integration:

- Paper trading runs continuously for at least 30 days.
- Every trade has a linked signal, regime, features, and risk decision.
- Dashboard shows open positions, closed trades, PnL, and drawdown.
- No trade can occur without risk approval.
- The system can be stopped with a kill switch.

---

# Priority 8 — Refactor Refresh Routes into Jobs

Current routes perform long-running work directly:

- `app/api/cache/refresh/route.ts`
- `app/api/regime/refresh/route.ts`
- `app/api/telegram/webhook/route.ts`

This includes sleeps for TAAPI rate limits. That is fragile in serverless.

## Change needed

Move long-running work into jobs.

Possible options:

- Vercel Cron + Supabase.
- Supabase Edge Functions.
- Inngest.
- Trigger.dev.
- Upstash QStash.
- A small VPS worker.

## Target flow

```text
POST /api/jobs/refresh
   ↓
creates job row
   ↓
worker claims job
   ↓
ingests bars / computes features / runs strategies / stores outputs
   ↓
GET /api/dashboard reads latest persisted outputs
```

## New tables

```sql
create table jobs (
  id bigserial primary key,
  job_type text not null,
  status text not null,
  payload jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz default now()
);
```

## Why this matters

A quant desk should not depend on a user clicking refresh and waiting for slow API calls.

---

# Priority 9 — Add Data Quality and Staleness Checks

Before signals are trusted, validate the data.

## Checks to add

```text
Bar timestamp is closed, not incomplete
No missing OHLC values
No impossible candle values: high < low, close outside high/low
Volume is present or explicitly marked unavailable
Feature timestamp matches bar timestamp
1H and 1D features are not stale
Exchange/source is consistent
No mixed BTC/USDT vs BTC-USD inconsistencies without explicit normalization
```

## Current issue

The current system mixes:

- TAAPI Binance `BTC/USDT`
- Yahoo `BTC-USD`

This can create mismatched price/volume behavior. For research and execution, use one canonical exchange/instrument.

Recommended canonical symbol:

```text
BTC/USDT on one selected exchange
```

Or:

```text
BTC/USD on Coinbase/Kraken
```

Pick one and normalize everything to it.

---

# Priority 10 — Make GPT Outputs Schema-Safe

The GPT agents currently parse model output manually with `JSON.parse(clean)`. That is okay for prototype, but a desk needs stricter validation.

## Change needed

Use `zod` schemas for every agent response.

New file:

```text
lib/agents/schemas.ts
```

Example:

```ts
import { z } from "zod";

export const MomentumScoutSchema = z.object({
  structure: z.object({
    price_vs_ema20: z.enum(["above", "below", "at", "unknown"]),
    ema20_slope: z.enum(["rising", "falling", "flat", "unknown"]),
    trend_bias: z.enum(["bullish", "bearish", "mixed", "unknown"]),
    momentum_classification: z.enum([
      "acceleration",
      "trend_continuation",
      "pullback_to_support",
      "extended_but_strong",
      "decelerating",
      "rollover_risk",
      "oversold_bounce",
      "neutral",
    ]),
    summary: z.string(),
  }),
  momentum_conditions: z.object({
    rsi_regime: z.enum(["oversold", "pullback_zone", "momentum_zone", "overbought", "unknown"]),
    rsi_direction: z.enum(["rising", "falling", "flat", "unknown"]),
    histogram_sign: z.enum(["positive", "negative", "zero", "unknown"]),
    histogram_direction: z.enum(["expanding", "contracting", "flat", "unknown"]),
    volume_context: z.enum(["strong", "moderate", "weak", "unknown"]),
    extension_state: z.enum(["normal", "extended", "deeply_extended", "unknown"]),
    summary: z.string(),
  }),
  implication: z.object({
    signal: z.enum(["BUY", "SELL", "WATCH", "NEUTRAL"]),
    confidence: z.enum(["High", "Moderate", "Low"]),
    summary: z.string(),
  }),
});
```

## Also add

- Retry once on invalid JSON.
- Store raw response.
- Store parse error.
- Store prompt version.
- Store model version.

---

# Priority 11 — Add Strategy/Agent Versioning

Every output should be attributable.

## Add constants

Each agent/strategy should export a version.

```ts
export const MOMENTUM_SCOUT_VERSION = "a1.2026-05-13.v1";
export const FEATURE_VERSION = "features.2026-05-13.v1";
export const CONFLUENCE_VERSION = "confluence.2026-05-13.v1";
```

Store these with outputs:

- `feature_version`
- `strategy_version`
- `agent_version`
- `prompt_version`
- `model_version`
- `confluence_version`

## Why it matters

Without versions, backtest/live performance becomes impossible to compare after changes.

---

# Priority 12 — Add Outcome Tracking

A signal is not useful unless the system measures what happened after it.

## Add signal outcome columns/table

Track forward returns after every signal:

```text
return_1h
return_4h
return_12h
return_24h
max_favorable_excursion
max_adverse_excursion
hit_stop_before_target
regime_at_signal
regime_after_24h
```

## New job

```text
jobs/evaluateSignalOutcomes.ts
```

This job should run periodically and update old signals once enough future bars exist.

## Why this matters

This converts the system from “looks smart” to “knows what works.”

---

# Proposed Folder Structure

```text
lib/
  agents/
    momentumScout.ts
    breakoutWatcher.ts
    trendFollower.ts
    volatilityArbiter.ts
    meanReversion.ts
    regimeDetector.ts
    schemas.ts
  backtest/
    backtestEngine.ts
    metrics.ts
    reportStore.ts
    slippage.ts
    types.ts
  confluence/
    confluenceEngine.ts
    scoreSignals.ts
  data/
    barStore.ts
    marketDataProvider.ts
    symbolMap.ts
  execution/
    fillSimulator.ts
    orderManager.ts
    paperBroker.ts
    types.ts
  features/
    featureEngine.ts
    featureStore.ts
    indicators.ts
  quant/
    types.ts
  regime/
    permissionMap.ts
    regimeContext.ts
  risk/
    killSwitch.ts
    positionSizing.ts
    riskEngine.ts
    types.ts
  storage/
    supabaseServer.ts
  strategies/
    breakoutExpansion.ts
    meanReversionBounce.ts
    momentumContinuation.ts
    strategyRegistry.ts
    trendPullback.ts
    types.ts
```

---

# API Route Revisions

## Keep but refactor

### `app/api/cache/refresh/route.ts`

Current behavior: runs everything directly and writes `memCache`.

Target behavior:

- Enqueue refresh job.
- Return job ID immediately.
- Dashboard reads latest persisted results from DB.

### `app/api/signals/route.ts`

Current behavior: reads `memCache`.

Target behavior:

- Read latest rows from `strategy_signals`, `regime_snapshots`, `trade_intents`, and `feature_snapshots`.
- Keep `memCache` only as optional read-through cache.

### `app/api/regime/refresh/route.ts`

Current behavior: fetches data, runs A6, returns result.

Target behavior:

- Either enqueue a regime job or run only if it can complete quickly.
- Store result in `regime_snapshots`.
- Use shared `permissionMap.ts`.

### `app/api/regime/[symbol]/route.ts`

Current behavior: reads `memCache.response.regimeMap`.

Target behavior:

- Read latest `regime_snapshots` row for the symbol.
- Enforce staleness threshold.
- Return `BLOCK` if stale.

---

# Dashboard Revisions

Add tabs/sections beyond current agent cards.

## New dashboard areas

### 1. Research Dashboard

Shows:

- Strategy performance by regime.
- Signal outcome analytics.
- Feature distribution.
- Recent false positives.
- Recent false negatives.

### 2. Backtest Dashboard

Shows:

- Backtest runs.
- Equity curve.
- Drawdown curve.
- Trade table.
- Metrics by regime.

### 3. Risk Dashboard

Shows:

- Current risk state.
- Max daily loss.
- Consecutive loss count.
- Open exposure.
- Kill switch status.
- Current allowed trade permissions.

### 4. Execution Dashboard

Shows:

- Paper orders.
- Fills.
- Open positions.
- Closed trades.
- Realized/unrealized PnL.

### 5. Agent Explainability Dashboard

Keep the existing agent cards here, but position them as explainability/research, not trade authority.

---

# Implementation Roadmap

## Phase 1 — Foundation cleanup

### Tasks

1. Fix A4/A5 UI metadata mismatch.
2. Create shared `lib/regime/permissionMap.ts`.
3. Filter A6 out of confluence votes and pass regime context separately.
4. Upgrade Next.js and clear dependency audit.
5. Replace `next/font/google` with local/fallback font.
6. Add `zod` response validation for GPT outputs.
7. Add version constants for agents/prompts/features.

### Acceptance criteria

- `npx tsc --noEmit` passes.
- `npm run build` passes without external font fetch failure.
- Regime mapping is identical across all endpoints.
- Confluence uses regime as context, not a vote.
- UI agent cards match actual agent IDs.

---

## Phase 2 — Persistent data foundation

### Tasks

1. Add Supabase tables for bars, features, regimes, signals, intents, orders, fills, positions, and backtests.
2. Create `barStore.ts` and `featureStore.ts`.
3. Add historical OHLCV ingestion for BTC.
4. Store 1H and 1D bars.
5. Compute indicators locally.
6. Store feature snapshots.

### Acceptance criteria

- Can ingest at least 2 years of BTC historical candles.
- Can calculate all current indicators locally.
- Can reproduce latest feature snapshot without TAAPI.
- Every feature row has symbol/timeframe/timestamp/version.

---

## Phase 3 — Deterministic strategy layer

### Tasks

1. Add `StrategySignal` type.
2. Build `strategyRegistry.ts`.
3. Implement first four BTC strategies:
   - Momentum continuation.
   - Pullback to support.
   - Breakout expansion.
   - Mean reversion bounce.
4. Store strategy outputs in `strategy_signals`.
5. Keep GPT agents as commentary/labels over strategy outputs.

### Acceptance criteria

- Strategies can run without GPT.
- Strategy output is deterministic from feature snapshots.
- Every signal stores strategy version and feature version.
- Dashboard can distinguish “strategy signal” from “agent commentary.”

---

## Phase 4 — Backtesting

### Tasks

1. Build event-driven backtest engine.
2. Add fee and slippage model.
3. Implement stop-loss and take-profit simulation.
4. Store backtest runs and trades.
5. Add API for running and reading backtests.
6. Add backtest dashboard.

### Acceptance criteria

- Can backtest each strategy on BTC 1H history.
- Reports win rate, max drawdown, profit factor, Sharpe approximation, and regime performance.
- Can compare strategy versions.
- Can export backtest results.

---

## Phase 5 — Risk engine and paper trading

### Tasks

1. Build risk engine.
2. Add account config.
3. Create trade intents.
4. Build paper broker.
5. Simulate fills.
6. Track positions and PnL.
7. Add kill switch.
8. Add execution dashboard.

### Acceptance criteria

- No paper trade can open without risk approval.
- Every trade links back to signal/features/regime.
- Dashboard shows open positions and PnL.
- Kill switch blocks new trades.
- Stale signals are rejected.

---

## Phase 6 — Production-grade scheduling

### Tasks

1. Move refresh work into scheduled jobs.
2. Add job table.
3. Add worker process.
4. Add job retries and failure logging.
5. Add staleness checks.
6. Add Telegram alerts for risk and execution events.

### Acceptance criteria

- No long-running market-data sleeps inside user-facing API routes.
- Refreshes happen automatically.
- Failed jobs are visible.
- Dashboard shows last successful run and stale data warnings.

---

# Specific Code Changes by File

## `config/agents.ts`

Keep IDs as-is, but ensure UI metadata matches:

```text
A1 Momentum Scout
A2 Breakout Watcher
A3 Trend Follower
A4 Volatility Arbiter
A5 Mean Reversion
A6 Regime Detector
```

## `components/agents/LiveAgentGrid.tsx`

Change:

- Swap A4/A5 metadata.
- Add separate card type for `Strategy Engine` later.
- Add “Agent Commentary” label to avoid confusing GPT outputs with executable strategies.

## `lib/confluence/scoreSignals.ts`

Change:

- Do not treat Regime Detector as a scored agent.
- Accept regime context.
- Add regime-based gates.
- Add confidence penalty when regime reliability is weak.
- Add explicit short-side support if short trading becomes part of BTC strategy.

## `lib/confluence/confluenceEngine.ts`

Change signature:

```ts
runConfluenceEngine(signals: Signal[], regimeMap: RegimeMap)
```

Add fields to output:

```ts
regime: string;
regimeReliability: number;
riskPermission: string;
blocked: boolean;
blockReason?: string;
```

## `app/api/cache/refresh/route.ts`

Near term:

- Filter A6 out of trading signal stats and confluence input.
- Pass `regimeMap` into confluence.

Long term:

- Replace direct execution with job creation.
- Persist outputs to DB instead of only `memCache`.

## `app/api/regime/[symbol]/route.ts`

Change:

- Read latest regime from DB.
- Use shared `permissionMap.ts`.
- Return `BLOCK` if no recent regime snapshot exists.

## `app/api/regime/refresh/route.ts`

Change:

- Use shared `permissionMap.ts`.
- Store regime result in DB.
- Add API auth before production use.

## `lib/indicatorCache.ts`

Short term:

- Keep as prototype cache.

Long term:

- Replace as source of truth with `market_bars` + `feature_snapshots`.
- Remove TAAPI dependency from core trading decisions.

## `lib/taapi.ts` and `lib/taapi1d.ts`

Short term:

- Keep for quick prototype.

Long term:

- Replace with local feature calculation from stored OHLCV.
- Keep TAAPI only as optional comparison/debug provider.

## `lib/polygon.ts`

Rename this file because it uses Yahoo, not Polygon.

Recommended:

```text
lib/market/yahooQuotes.ts
```

Long term, replace with exchange-native BTC quote source.

---

# Do Not Add Yet

Avoid these until the foundation exists:

- Live exchange execution.
- More symbols.
- More GPT agents.
- More indicators.
- Complex ML models.
- Bonds/macro integration.
- Options/futures logic.
- Leverage.

The next level is not “more predictors.” The next level is **measurement, risk, and execution discipline**.

---

# Later: Bonds and Macro Integration

Do not add bonds immediately. Add the placeholder now.

## Add future table

```sql
create table macro_factors (
  id bigserial primary key,
  factor text not null,
  ts timestamptz not null,
  value numeric not null,
  source text not null,
  inserted_at timestamptz default now(),
  unique(factor, ts, source)
);
```

Future factors:

```text
US10Y yield
US02Y yield
2Y/10Y spread
DXY
MOVE index
VIX
Fed funds expectations
Liquidity proxies
```

Future use:

```text
macro_factors → macro regime → risk multiplier → strategy permission
```

For now, keep the BTC desk self-contained.

---

# Final Recommended North Star

Build toward this operating model:

```text
1. Ingest BTC bars every candle close.
2. Calculate local features.
3. Store feature snapshots.
4. Classify regime.
5. Run deterministic strategies.
6. Run confluence/risk checks.
7. Create trade intent only if approved.
8. Paper trade first.
9. Track every outcome.
10. Use GPT to explain the system, not to replace the system.
```

The current codebase is a strong prototype because it already has modular agents, regime classification, confluence scoring, and a clean dashboard. The next major revision is to make it **persistent, replayable, measurable, and risk-controlled**.

That is the move from a market predictor to a lightweight quant desk.
