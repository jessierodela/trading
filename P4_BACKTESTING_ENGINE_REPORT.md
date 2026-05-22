# P4 Backtesting Engine Report

## What Was Implemented

P4 adds a deterministic, pure backtesting engine for the P3 strategy layer.

Implemented:
- Backtest simulation types in `lib/backtest/types.ts`.
- Fee/slippage helpers in `lib/backtest/slippage.ts`.
- Metrics calculator in `lib/backtest/metrics.ts`.
- Pure backtest engine in `lib/backtest/backtestEngine.ts`.
- Postgres and in-memory report stores in `lib/backtest/reportStore.ts`.
- `POST /api/backtests/run` for authenticated backtest runs.
- `GET /api/backtests/[id]` for authenticated persisted result reads.
- `_smoke/backtest.ts` with handcrafted fixtures.
- `npm run smoke:backtest`.
- Backtest run API validation for invalid timestamps, unsupported exchanges, and unsupported timeframes.
- Defensive persisted-run lookup that returns null/404 for malformed public IDs instead of surfacing database UUID parse errors.

## Backtest Assumptions

- V1 persisted run is one strategy, one symbol, one timeframe, one feature version, and one strategy version.
- V1 supports one open position at a time.
- V1 supports long trades first. Short signals are skipped unless explicitly allowed.
- The engine is simulation-only. It does not submit orders, create trade intents, run paper trading, or call a production risk engine.
- The engine is pure: arrays in, `BacktestResult` out. No DB, network, GPT, or clock calls occur inside simulation logic.
- V1 rejects gapped bar or feature windows by default. This avoids silently bridging missing 1H candles and missing stop/target/drawdown events inside data gaps.

## Entry And Exit Rules

- Strategies are evaluated on feature bar `i`.
- Entry happens on the next bar open at `i + 1`.
- Last-bar signals are skipped because no next bar exists.
- Entries cannot bridge missing candle intervals because bars and features must be contiguous for the configured timeframe.
- API callers must provide valid `startTs` and `endTs`, a supported exchange, and the V1 `1h` timeframe before data fetch starts.
- Only `trigger` signals can open trades.
- Signals without usable `stopLoss` or `invalidationPrice` are skipped.
- Long trades reject stops above or equal to entry.
- Stop/target exits use OHLC.
- If stop and target are both touched in one bar, stop-loss wins pessimistically.
- Open trades close at final bar close when `closeOpenPositionAtEnd` is true.
- Open trades remain `no_exit` when `closeOpenPositionAtEnd` is false.
- 1D daily features are only used after the daily candle is fully closed.

## Fee, Slippage, And Sizing

- Long entries pay worse price: `open * (1 + slippageBps / 10000)`.
- Long exits receive worse price: `exit * (1 - slippageBps / 10000)`.
- Fees apply on both entry and exit notional.
- Sizing is backtest-only:
  - `riskUsd = equity * riskPerTradePct`
  - `quantityByRisk = riskUsd / riskPerUnit`
  - `quantityByMaxNotional = (equity * maxPositionPct) / entryPrice`
  - `quantity = min(quantityByRisk, quantityByMaxNotional)`

## Metrics Implemented

- Ending equity
- Total return
- CAGR when duration is at least 365 days
- Max drawdown
- Trade count
- Win rate
- Average winner and loser
- Profit factor
- Expectancy per trade
- Sharpe approximation
- Sortino approximation
- Exposure time
- Average hold hours
- Best and worst trade
- Max consecutive losses
- Regime performance
- UTC time-of-day performance
- Notes for unavailable metrics

## API Examples

Run:

```http
POST /api/backtests/run
X-Backfill-Secret: <secret>
Content-Type: application/json
```

```json
{
  "symbol": "BTC-USD",
  "exchange": "COINBASE",
  "timeframe": "1h",
  "strategyId": "momentum_continuation",
  "startTs": "2024-05-21T00:00:00Z",
  "endTs": "2026-05-21T00:00:00Z",
  "persist": true
}
```

Read:

```http
GET /api/backtests/1?trades=summary
X-Backfill-Secret: <secret>
```

## Smoke Test Count And Results

Validated locally:
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed. Existing `SignalsPanel.tsx` hook dependency warning remains.
- `npm.cmd run smoke:features`: passed, 71 assertions.
- `npm.cmd run smoke:p2d`: passed, 23 assertions.
- `npm.cmd run smoke:strategies`: passed, 99 assertions.
- `npm.cmd run smoke:backtest`: passed, 82 assertions.

## Files Changed

- `lib/backtest/types.ts`
- `lib/backtest/slippage.ts`
- `lib/backtest/metrics.ts`
- `lib/backtest/backtestEngine.ts`
- `lib/backtest/reportStore.ts`
- `app/api/backtests/run/route.ts`
- `app/api/backtests/[id]/route.ts`
- `_smoke/backtest.ts`
- `package.json`
- `P4_BACKTESTING_ENGINE_REPORT.md`
- `md/changes-updates/P4_BACKTESTING_ENGINE_CHANGES.md`

## Known Limitations

- V1 is single-strategy per persisted run.
- V1 assumes one open position at a time.
- V1 supports long trades first.
- Sharpe and Sortino are approximations.
- No portfolio-level allocation yet.
- No confluence backtesting yet.
- No live execution.
- No paper trading.
- No production risk engine.

## Next Phase

This is simulation only. Production risk engine, paper trading, and live execution remain future phases.
