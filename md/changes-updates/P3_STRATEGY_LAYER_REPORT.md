# P3 Strategy Layer Report

## What was implemented

Phase 3 adds a deterministic strategy layer that turns validated `FeatureSnapshot` rows into versioned `StrategySignal` outputs without GPT, TAAPI, Yahoo, network calls, randomness, or live execution.

Implemented:
- Shared strategy contract in `lib/strategies/types.ts`.
- Strategy helpers in `lib/strategies/helpers.ts`.
- Four deterministic strategy modules.
- Strategy registry and lookup helpers.
- `runStrategyWindow()` for sorted feature-window evaluation and optional `SignalStore` persistence.
- `POST /api/strategies/run` for running strategies from persisted `feature_snapshots`.
- `_smoke/strategies.ts` with handcrafted deterministic fixtures.
- `smoke:strategies` package script.
- Small dashboard copy distinguishing deterministic strategy signals from GPT commentary.

Pre-merge hardening:
- Strategy modules now use module-level `STRATEGY_ID` and `STRATEGY_VERSION` constants inside `evaluate()`.
- Strategy API feature fetch, daily feature fetch, and strategy execution/persistence are wrapped with structured JSON error responses.
- Strategy API daily context fetch starts three UTC days before `startTs`.
- `runStrategyWindow()` defensively sorts daily feature rows before selecting daily context.
- `runStrategyWindow()` only uses a 1d feature after that daily bar is fully closed (`daily ts + 24h <= intraday ts`) to avoid lookahead bias.

## Strategy IDs and versions

| Strategy ID | Version |
| --- | --- |
| `momentum_continuation` | `strategy.momentum_continuation.2026-05-21.v1` |
| `trend_pullback` | `strategy.trend_pullback.2026-05-21.v1` |
| `breakout_expansion` | `strategy.breakout_expansion.2026-05-21.v1` |
| `mean_reversion_bounce` | `strategy.mean_reversion_bounce.2026-05-21.v1` |

All versions are centralized in `STRATEGY_VERSIONS` in `lib/versions.ts`. Compatibility constants remain for existing code that imports the previous names.

## Strategy logic summary

`momentum_continuation` emits long continuation setups/triggers when price is above EMA20, EMA20 slope is positive, MACD histogram is positive and expanding, RSI is in the 50-70 continuation band, and candle range is not overextended.

`trend_pullback` emits long pullback setups/triggers when broader daily context is bullish or unavailable, price is near EMA20, RSI has cooled into 40-50, and MACD is positive or improving.

`breakout_expansion` emits long breakout triggers when Bollinger width expands, close breaks above the upper band, optional relative-volume/MACD confirmations pass, and range expansion is not excessive.

`mean_reversion_bounce` emits lower-confidence long countertrend bounce setups/triggers when RSI is oversold or rising from sub-35, price is stretched below EMA20, and MACD histogram is improving.

Regime handling:
- `NEWS_SHOCK` blocks entry signals.
- `CHOP` reduces confidence and can downgrade triggers to setups.
- Reliable `TREND_DOWN` downgrades long momentum and countertrend bounce signals.
- Null regime is treated as neutral.

## Smoke test count and results

Commands run:

```bash
npx.cmd tsc --noEmit
npm.cmd run build
npm.cmd run smoke:features
npm.cmd run smoke:p2d
npm.cmd run smoke:strategies
```

Results:
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed. Existing React hook dependency warning remains in `components/layout/SignalsPanel.tsx`.
- `npm.cmd run smoke:features`: passed, 71 assertions.
- `npm.cmd run smoke:p2d`: passed, 23 assertions.
- `npm.cmd run smoke:strategies`: passed, 99 assertions.

The strategy smoke covers required-null handling, each strategy firing on handcrafted features, `NEWS_SHOCK`, `CHOP`, reliable `TREND_DOWN`, deterministic JSON output, one signal per strategy per bar, window validation, unsorted daily context handling, same-day daily lookahead prevention, in-memory persistence, and duplicate persistence counting.

## Files changed

- `lib/versions.ts`
- `lib/strategies/types.ts`
- `lib/strategies/helpers.ts`
- `lib/strategies/momentumContinuation.ts`
- `lib/strategies/trendPullback.ts`
- `lib/strategies/breakoutExpansion.ts`
- `lib/strategies/meanReversionBounce.ts`
- `lib/strategies/strategyRegistry.ts`
- `lib/strategies/runStrategyWindow.ts`
- `app/api/strategies/run/route.ts`
- `_smoke/strategies.ts`
- `package.json`
- `components/layout/SignalsPanel.tsx`
- `md/changes-updates/P3_STRATEGY_LAYER_REPORT.md`
- `md/changes-updates/P3_STRATEGY_LAYER_CHANGES.md`

## Explicit non-goals

This phase does not prove profitability.

This phase does not add live execution, risk approval, paper trading, a full backtesting engine, or live signal pipeline cutover.

GPT agents remain commentary/research/explainability only. They are not the authority for deterministic trade decisions.

## Next phase

Backtesting is the next phase. These deterministic signals are now testable inputs for evaluating expectancy, drawdown, trade frequency, regime sensitivity, and threshold quality.
