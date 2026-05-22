# P4 Live Backtest Validation

## Summary

Validated the P4 backtesting engine end-to-end on `main` against the live Vercel deployment:

- App: `https://trading-teal-phi.vercel.app`
- Branch: `main`
- Strategy: `momentum_continuation`
- Symbol: `BTC-USD`
- Exchange: `COINBASE`
- Timeframe: `1h`
- Window: `2026-05-09T00:00:00Z` through `2026-05-15T00:00:00Z`
- Persistence: enabled

No live execution, paper trading, production risk engine, broker integration, order manager, dashboard overhaul, or live pipeline cutover was involved.

## Initial Backtest Attempt

The first persisted backtest request reached the route and authenticated, but the requested window did not yet have persisted feature rows for the active feature version.

Response:

```json
{
  "ok": false,
  "stage": "backtest",
  "error": "features are required"
}
```

This confirmed the structured P4 route error path is working correctly.

## Feature Seeding

The requested window was seeded through `POST /api/features/compute` using segmented mode.

Result:

```json
{
  "ok": true,
  "mode": "segmented",
  "symbol": "BTC-USD",
  "exchange": "COINBASE",
  "timeframe": "1h",
  "featureVersion": "features.2026-05-20.v3",
  "barsRead": 144,
  "rowsComputed": 144,
  "rowsPersisted": 144,
  "gapCount": 0
}
```

Validation notes:

- 144 hourly bars were read.
- 144 feature rows were computed and persisted.
- The window was one contiguous segment.
- `gapCount` was `0`.

## Persisted Backtest Result

After feature seeding, the persisted backtest succeeded.

Result:

```json
{
  "ok": true,
  "persisted": {
    "id": "1",
    "publicId": "a9042ea2-3987-48ec-9871-5d7c476ed784",
    "tradesInserted": 5
  },
  "strategyId": "momentum_continuation",
  "strategyVersion": "strategy.momentum_continuation.2026-05-21.v1",
  "tradeCount": 5,
  "metrics": {
    "endingEquity": 9882.825088308382,
    "totalReturnPct": -1.1717491169161804,
    "maxDrawdownPct": 2.3303449053458296,
    "winRatePct": 20,
    "profitFactor": 0.41941446599250803,
    "numberOfTrades": 5
  },
  "notes": [
    "CAGR unavailable for windows shorter than 365 days"
  ]
}
```

## Readback Validation

Readback was validated using:

```http
GET /api/backtests/a9042ea2-3987-48ec-9871-5d7c476ed784?trades=summary
```

Result:

```json
{
  "ok": true,
  "run": {
    "id": "1",
    "publicId": "a9042ea2-3987-48ec-9871-5d7c476ed784",
    "strategyId": "momentum_continuation",
    "strategyVersion": "strategy.momentum_continuation.2026-05-21.v1",
    "symbol": "BTC-USD",
    "exchange": "COINBASE",
    "timeframe": "1h",
    "startTs": "2026-05-09T00:00:00.000Z",
    "endTs": "2026-05-15T00:00:00.000Z"
  },
  "tradeCount": 5
}
```

Readback confirmed:

- The persisted run was retrievable by `publicId`.
- The returned run matched the requested symbol, exchange, timeframe, strategy, and date window.
- The persisted trade count matched the original backtest response.
- Trade summary returned first, last, and sample trades.

## Conclusion

P4 live DB wiring is validated end-to-end:

- Feature persistence works for the requested backtest window.
- Backtest run persistence works.
- Trade persistence works.
- Public ID readback works.
- Structured failure behavior works when required features are missing.

The P4 implementation remains simulation-only.
