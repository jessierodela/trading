# P2C Feature Engine — What Shipped

The locked-in contract from the auditor's direction, implemented. Engine
refuses to compute strategy-grade features across missing candle ranges.
Two explicit entry points, no flags, no shared unsafe public function.

## Validation

```
npx tsc --noEmit              # clean
npm run build                 # clean — /api/features/compute in route manifest
npm run smoke:features        # 70/70 — math correctness, gap detection,
                              # warmup-does-not-cross-gaps, determinism
npm run smoke:backfill        # 40/40 — no regression
npm run smoke:storage         # 38/38 — no regression
npm run lint                  # 1 pre-existing SignalsPanel warning, unchanged
```

## Files

### New

```
lib/features/indicators.ts             (RSI, EMA, SMA, ATR, MACD, BB — streaming closures)
lib/features/gaps.ts                   (validation, gap detection, suffix, segmentation)
lib/features/engine.ts                 (the two public entry points)
app/api/features/compute/route.ts      (HTTP layer, explicit mode required)
_smoke/features.ts                     (70 assertions)
```

### Modified

```
lib/versions.ts                        (FEATURE_VERSION bumped v1 stub → v2 real engine)
package.json                           (added smoke:features script)
```

## The contract, as implemented

### Two public entry points, two names, no flags

**`computeFeaturesLatest(bars)`** — for live / on-demand use.

- Operates on the longest contiguous suffix ending at the most recent bar.
- Throws `NoUsableSuffixError` on empty input.
- Throws `BarIntegrityError` on corrupt input (duplicate ts, mixed
  symbols, misaligned ts, non-ascending).
- Returns `LatestFeatureResult` with `rows`, `seriesStartTs`,
  `seriesEndTs`, and `droppedPreGapCount` for diagnostic visibility.

**`computeFeaturesSegmented(bars)`** — for historical persistence / backtest seeding.

- Splits input into contiguous segments at every gap.
- Computes each segment independently. Indicator state NEVER carries
  across a gap — warmup restarts at every segment boundary.
- Empty input → empty result (rows=[], segments=[]), no throw.
- Returns `SegmentedFeatureResult` with flat `rows[]` plus `segments[]`
  sidecar (per auditor's choice of shape A).

### Private contiguous computer

`_computeContiguous(bars)` is the shared math. NOT exported. The only
paths to reach it are the two public entry points, both of which validate
input before calling. Internal callers physically cannot reach the math
without crossing a gap-aware boundary.

### Route picks mode explicitly

`POST /api/features/compute` requires `mode: "latest" | "segmented"` in
the body. Missing or invalid → 400. Same secret-header auth as
`/api/backfill/btc`, reusing `BACKFILL_SECRET` (with `FEATURES_SECRET`
preferred if set, for the transitional split-secret case).

## The math

| Indicator       | Math                                          | Warmup       |
|-----------------|-----------------------------------------------|--------------|
| `rsi14`         | Wilder's smoothing, period 14                 | 14 bars      |
| `ema20/50/200`  | Standard EMA, α = 2/(n+1), seeded with SMA(n) | n-1 bars     |
| `ema*Slope`     | current EMA − previous EMA                    | n bars       |
| `atr14`         | Wilder's smoothing on TR                      | 14 bars      |
| `atrPct`        | atr14 / close × 100                           | follows atr  |
| `macd`          | EMA12 − EMA26                                 | 25 bars      |
| `macdSignal`    | EMA9 of macd                                  | 33 bars      |
| `macdHist`      | macd − macdSignal                             | 33 bars      |
| `bb20`          | SMA20 ± 2 × population stdev                  | 19 bars      |
| `bbWidth`       | (upper − lower) / middle                      | follows bb   |
| `bbWidthPrev`   | previous bar's bbWidth (for compression/expansion detection) | 20 bars |
| `volumeSma20`   | Simple SMA of volume                          | 19 bars      |
| `relativeVolume20` | volume / volumeSma20                       | follows sma  |
| `distanceFromEma20Atr` | (close − ema20) / atr14                 | follows atr+ema20 |
| `candleRangeAtr` | (high − low) / atr14                         | follows atr  |

Wilder smoothing chosen for RSI/ATR per auditor decision — matches TAAPI
and TradingView convention; sets up clean cross-validation in P2D.
Population stdev for BB (not sample stdev) — same reason.

## Critical correctness invariant

**Warmup does not cross gaps.**

The smoke test exercises this directly with a 500-bar series gapped at bar
300. Test fixtures:

- Segment 1 = 300 bars (more than enough to warm EMA200).
- Segment 2 = 200 bars after a gap.

Asserted, all green:

- Last row of segment 1: `ema200 !== null` ✓
- First row of segment 2: `ema200 === null` ✓ (warmup reset)
- First row of segment 2: `ema50 === null` ✓
- First row of segment 2: `rsi14 === null` ✓
- Row 200 of segment 2: `ema200 !== null` ✓ (warmup completed within segment)

If a future edit accidentally carries indicator state across a gap, this
test fails immediately.

## Determinism

The engine is deterministic by construction:

- No `Date.now` in math.
- No `Math.random`.
- No `Map` iteration order dependence.
- All indicator state is closure-local to a single contiguous computation.
- Bars are read by index, not by query order.

The smoke test asserts bit-identical output (via JSON.stringify equality)
across two runs on the same input. Three assertions:

- Segmented: identical across two runs ✓
- Latest: identical across two runs ✓
- Segmented and Latest agree on fully-contiguous input ✓

## Gap-semantics ruling, implemented

| Case | Behavior |
|---|---|
| 1h missing UTC hour | Detected as gap |
| 1d missing UTC day | Detected as gap |
| Duplicate ts | `BarIntegrityError` (separate from gap) |
| Misaligned ts (1h not on :00, 1d not at UTC midnight) | `BarIntegrityError` |
| Mixed symbol/exchange/timeframe | `BarIntegrityError` |
| Non-ascending | `BarIntegrityError` |
| No market-calendar logic | Confirmed — engine doesn't know about weekends |

Two error classes distinguish "this is an upstream bug" (`BarIntegrityError`)
from "there is nothing to compute against" (`NoUsableSuffixError`), so
callers can handle them differently.

## What was NOT done in P2C (deliberately)

- **No live cross-validation against TAAPI.** That's P2D. Wilder's
  smoothing was chosen specifically so P2D can be a sharp ±0.5% test
  rather than a fuzzy one.
- **No `FEATURES_SECRET` env split.** Reuses `BACKFILL_SECRET` per
  auditor's call ("avoid secret sprawl now, P6 wires uniform auth").
  Code does check `FEATURES_SECRET` first as a transitional escape hatch.
- **No 1d→1h cross-timeframe overlay.** `daily_ema50AboveEma200` and
  `daily_priceAboveEma200` on 1h rows are left null by the engine; that
  join happens in a separate pass once both timeframes are populated.
  Strategy code (P3+) does the join.
- **No live route smoke.** The HTTP route is a thin wrapper over the
  engine (which has 70 in-process assertions) and `PgFeatureStore`
  (covered by `_smoke/storage.ts`). End-to-end verification is a curl
  after deploy:

```bash
curl -X POST https://your-app.vercel.app/api/features/compute \
  -H "Content-Type: application/json" \
  -H "X-Backfill-Secret: ${BACKFILL_SECRET}" \
  -d '{
    "mode":      "segmented",
    "symbol":    "BTC-USD",
    "exchange":  "COINBASE",
    "timeframe": "1h",
    "startTs":   "2025-05-16T00:00:00Z",
    "endTs":     "2026-05-15T00:00:00Z"
  }'
```

Expected on a healthy backfilled DB: ~8760 bars read, ~8760 rows computed,
~8760 rows persisted (or 0 on re-run — featureStore has unique constraint
on (symbol, exchange, timeframe, ts, feature_version)), `segments` array
with 1+ entries, `gaps` array surfacing any holes.

## P2 status update

| Plan acceptance criterion                                       | Status |
|-----------------------------------------------------------------|--------|
| Can ingest at least 2 years of BTC historical candles           | ✅ P2B bootstrap |
| Can calculate all current indicators locally                    | ✅ P2C |
| Can reproduce latest feature snapshot without TAAPI             | ⬜ P2D cross-validation |
| Every feature row has symbol/timeframe/timestamp/version        | ✅ (validator from P2A, engine stamps version) |

Next: **P2D** — cross-validate local feature values against TAAPI for a
sample of recent bars at ±0.5% tolerance. If matching, the live signals
pipeline cuts over from TAAPI to feature_snapshots.
