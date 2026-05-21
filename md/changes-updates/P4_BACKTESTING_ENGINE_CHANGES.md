# P4 Backtesting Engine Changes

## Summary

Built the P4 backtesting engine on branch `ai/p4-backtesting-engine`.

The engine makes deterministic strategy performance measurable with next-bar entries, OHLC stop/target handling, pessimistic same-bar stop-first behavior, fees, slippage, sizing, equity curve, metrics, and persisted backtest reports.

## What Changed

- Added `lib/backtest/types.ts`.
- Added `lib/backtest/slippage.ts`.
- Added `lib/backtest/metrics.ts`.
- Added `lib/backtest/backtestEngine.ts`.
- Added `lib/backtest/reportStore.ts`.
- Added `POST /api/backtests/run`.
- Added `GET /api/backtests/[id]`.
- Added `_smoke/backtest.ts`.
- Added `npm run smoke:backtest`.
- Added `P4_BACKTESTING_ENGINE_REPORT.md`.

## Validation

Passed:
- `npx.cmd tsc --noEmit`
- `npm.cmd run build`
- `npm.cmd run smoke:features` - 71 assertions
- `npm.cmd run smoke:p2d` - 23 assertions
- `npm.cmd run smoke:strategies` - 99 assertions
- `npm.cmd run smoke:backtest` - 75 assertions

Build warning:
- Existing `components/layout/SignalsPanel.tsx` `react-hooks/exhaustive-deps` warning remains.

## Scope Boundaries

No live execution, paper trading, production risk engine, broker integration, order manager, dashboard overhaul, or live pipeline cutover was added.

This phase is simulation only. The goal is repeatable measurement, not proof of profitability.
