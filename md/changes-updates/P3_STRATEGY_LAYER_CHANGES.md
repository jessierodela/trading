# P3 Strategy Layer Changes

## Summary

Built the deterministic strategy layer on branch `ai/p3-strategy-layer`.

The new layer consumes validated `FeatureSnapshot` rows and emits versioned `StrategySignal` outputs through four deterministic strategies:
- `momentum_continuation`
- `trend_pullback`
- `breakout_expansion`
- `mean_reversion_bounce`

## What changed

- Added `STRATEGY_VERSIONS` to `lib/versions.ts`.
- Added strategy contract/helpers/registry under `lib/strategies`.
- Added four deterministic strategy modules.
- Added `runStrategyWindow()` with sorted-window validation and optional `SignalStore` persistence.
- Added `POST /api/strategies/run` for feature-backed strategy execution.
- Added `_smoke/strategies.ts` and `npm run smoke:strategies`.
- Added dashboard copy clarifying deterministic strategy signals vs GPT commentary.
- Added full implementation report at `P3_STRATEGY_LAYER_REPORT.md`.

## Pre-merge hardening

- Replaced strategy-module `this.id` / `this.version` usage inside `evaluate()` with module-level `STRATEGY_ID` and `STRATEGY_VERSION` constants.
- Wrapped strategy API feature fetch, daily feature fetch, and strategy execution/persistence in structured JSON error responses.
- Expanded strategy API daily context fetch to `startTs - 3 UTC days` through `endTs`.
- Defensively sort `dailyFeatures` in `runStrategyWindow()` before daily context selection.
- Require a 1d feature to be fully closed (`daily ts + 24h <= intraday ts`) before it can inform a 1h strategy signal.
- Added smoke coverage for unsorted daily feature rows.
- Added smoke coverage proving same-day daily rows are not used for intraday signals.

## Validation

Passed:
- `npx.cmd tsc --noEmit`
- `npm.cmd run build`
- `npm.cmd run smoke:features` - 71 assertions
- `npm.cmd run smoke:p2d` - 23 assertions
- `npm.cmd run smoke:strategies` - 99 assertions

Build warning:
- `components/layout/SignalsPanel.tsx` still has an existing `react-hooks/exhaustive-deps` warning for `useEffect` dependencies.

## Scope boundaries

No live execution, risk engine, paper trading, full backtesting engine, or live pipeline cutover was added.

This phase does not prove profitability. Backtesting is the next phase.
