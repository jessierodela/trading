# ARCHITECTURE

The architectural contract for the BTC quant desk. Sets the design choices that
later phases (P2 persistence, P3 features, P4 strategies, P5 backtest, P6 risk,
P7 paper trading) all bind to. Bind to these before writing more code.

Last revised: May 13, 2026.

---

## Decision log

These are the load-bearing choices. Change them deliberately, not by accident.

### 1. Persistence: Supabase (Postgres)

Schema lives in Supabase. The `@supabase/supabase-js` package is already in
`package.json`. Tables defined in `QUANT_DESK_CONVERSION_PLAN.md` P2 are the
starting point.

Rationale: managed Postgres, free tier sufficient for early stages, REST +
realtime + row-level security available without standing up Postgres ourselves.
Plays cleanly with both Vercel (Next.js read APIs) and Railway (worker).

Reversible? Largely yes — `@supabase/supabase-js` is a thin wrapper. The schema
is pure Postgres. If we ever outgrow Supabase, the migration is hosting-level,
not application-level.

### 2. Market data provider: Coinbase Exchange (BTC-USD)

For BTC bars: Coinbase WebSocket (`matches` channel for trade ticks) + REST for
backfill and historical candles. Aggregate 1m bars locally; roll up to 5m, 15m,
1h, 1d.

Rationale:
- Free, no API key needed for public market data.
- BTC-USD spot on a US-regulated exchange. Canonical instrument for the desk.
- Trade-level data available means we can compute true volume — fixes the
  TAAPI vwma-as-volume bug from the current system.
- WebSocket gives bar-close latency of ~1 second.

What this is NOT: a multi-asset provider. When the desk expands beyond BTC,
revisit this decision. Likely options: Polygon (paid, US-listed multi-asset)
or keep per-asset-class providers and unify at the bar store layer.

The canonical instrument is `{exchange: "COINBASE", symbol: "BTC-USD"}`. Every
bar, feature, signal, and trade is tagged with this pair. If a future row says
`exchange: "BINANCE"` it is explicitly different data — never silently mixed.

### 3. Asset scope: BTC first, schema multi-asset from day one

The pipeline ingests only BTC initially. But every table has `symbol` and
`exchange` columns from the start, and the code paths assume there can be
multiple. Adding ETH, SOL, or stocks is then a config change, not a refactor.

What this means in practice: `barStore.fetchBars(symbol, exchange, timeframe, ...)`
not `barStore.fetchBtcBars(timeframe, ...)`.

### 4. Runtime split: Vercel + Railway + Supabase

```
┌─────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Vercel         │      │  Railway worker  │      │  Supabase        │
│  (Next.js)      │      │  (Node process)  │      │  (Postgres)      │
│                 │      │                  │      │                  │
│  - UI           │─────▶│  - WS ingest     │─────▶│  - market_bars   │
│  - read APIs    │      │  - feature compute│      │  - features      │
│  - dashboard    │      │  - strategy runs │      │  - signals       │
│  - regime API   │      │  - paper broker  │      │  - trades        │
│                 │◀─────│                  │◀─────│  - regimes       │
└─────────────────┘      └──────────────────┘      └──────────────────┘
        ▲                                                    ▲
        │              (read everything)                     │
        └────────────────────────────────────────────────────┘
```

What runs where:
- **Vercel**: anything the user hits directly. Dashboard, `/api/signals`,
  `/api/regime/*`, telegram webhook. Stays under 60s. Reads only.
- **Railway**: long-running worker process. Subscribes to Coinbase WebSocket,
  writes bars on close, runs feature engine, runs strategies, runs paper
  broker, runs backtest jobs. Owns all writes.
- **Supabase**: shared state. Both sides read it. Only the worker writes
  (with one exception: telegram webhook may write user-triggered actions).

Why the split: Vercel serverless can't hold a WebSocket open. Coinbase
WebSocket needs a persistent process. Railway is cheapest and simplest for
that. The boundary is: Vercel is the reader, Railway is the writer.

What this means in practice: no long-running work in Next.js routes. If the
current routes need to "refresh" something they enqueue a job; the worker
picks it up.

### 5. Language: TypeScript end-to-end

Both Vercel and Railway run TS/Node. Shared types in `lib/` are usable on both
sides without bridges. Signals, features, strategies, risk decisions — all one
type system from compute to storage to read.

Trade-off: TS lacks pandas/numpy/scipy. We accept this. The desk is a defined
pipeline, not exploratory research. When/if we add ML, we can stand up a
Python sidecar that talks to Supabase. Until then, one language wins.

### 6. Versioning: light, manual, mandatory

Every row stored carries lineage stamps for code, prompt, and model versions.
Versions are string constants in `lib/versions.ts`, bumped manually when
logic changes. See `lib/versions.ts` for the registry.

The discipline is enforced socially (code review checks for version bumps
when semantics change), not automatically. Cost of forgetting: comparison
of "v1" vs "v2" rows is meaningless. This is acceptable risk in exchange
for grep-able version names.

Stamped on every row written:
- `feature_version` on `feature_snapshots`
- `strategy_version` on `strategy_signals`
- `regime_model_version` on `regime_snapshots`
- `prompt_version` + `model_version` on any GPT-derived row

Old rows are never rewritten. A row tagged `v1` keeps `v1` forever.

### 7. Cadence: bar-close-driven

The system reacts when bars close, not on a schedule.

WebSocket trade stream → aggregate to 1m → on 1m close, persist + cascade
rollups (5m/15m/1h/1d) when their windows close → trigger feature compute
→ trigger strategy runs → trigger risk + paper broker.

Latency target: under 5 seconds from bar close to strategy decision for 1m;
under 30 seconds for 1h.

If WebSocket disconnects, the worker reconnects and backfills missing bars
via Coinbase REST. The DB is the source of truth — never reaches a state
where we have a hole.

This is NOT tick-by-tick strategy execution. Strategies operate on closed
bars only. The trade stream is just the cheapest way to know a bar closed.

---

## Pipeline (target)

```text
Coinbase WS trade stream
    ↓
local bar aggregator (1m)
    ↓
on 1m close → market_bars insert (+ cascade rollups)
    ↓
feature engine reads recent bars → computes indicators → feature_snapshots insert
    ↓
regime detector reads features → regime_snapshots insert
    ↓
strategy registry runs each strategy → strategy_signals insert
    ↓
GPT agents run on signal (not on schedule) → narrative/labels stored
    ↓
confluence engine arbitrates strategy outputs + regime gate → trade intent
    ↓
risk engine reviews intent → approved or rejected
    ↓
paper broker submits → fill simulator fills → positions table updated
    ↓
exit conditions monitored → position closed → PnL realized
```

Two important deviations from the plan as written:

1. **GPT agents run on signal, not every refresh.** When a deterministic
   strategy fires, an agent commentary call may follow to label/narrate it.
   When no strategy fires, no GPT calls happen. This eliminates the
   cost-per-cycle tax of the current architecture.

2. **Confluence becomes an arbitrator, not a scorer.** Today confluence
   scores GPT agent votes. In the target, deterministic strategies generate
   signals and confluence reconciles when multiple fire on the same symbol
   simultaneously (e.g. momentum continuation says buy, mean reversion bounce
   says watch). Regime gating moves into the risk engine, not confluence.

---

## Boundaries and contracts

The cross-cutting types live in `lib/quant/types.ts`. Every later phase imports
from there. Touching that file affects multiple phases — change deliberately.

The version registry lives in `lib/versions.ts`. Bump versions there, not
inline in each module.

Storage interfaces (not implementations) live in `lib/storage/`. A `BarStore`,
`FeatureStore`, `SignalStore`, etc. are interfaces. Today they're satisfied by
a Supabase implementation; tests can satisfy them with in-memory mocks.

---

## What this contract does NOT decide

Deliberately deferred:
- Specific risk multipliers (P6 decision)
- Specific strategy rules (P4 decision)
- Specific feature definitions beyond the existing indicator set (P3 decision)
- ML inclusion (deferred indefinitely per plan's Do Not Add Yet)
- Live execution (deferred until after 30 days of clean paper trading per plan)
- Multi-asset expansion (deferred until BTC desk is mature)

---

## What "done" looks like for Priority 1

P1 is done when:
- `ARCHITECTURE.md` is reviewed and accepted (this file)
- `lib/quant/types.ts` defines the cross-cutting types
- `lib/versions.ts` defines the version registry
- All later code imports from these instead of redefining shapes

Implementation of the pipeline (ingestion, features, strategies, backtest,
risk, paper trading) is P2-P7. Those phases bind to this contract.
