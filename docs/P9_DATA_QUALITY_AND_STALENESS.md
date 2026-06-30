# P9B Data Quality and Staleness Gates

P9B adds deterministic quality gates before market bars, features, regimes, strategies, and dashboard snapshots are trusted. It does not migrate every provider to one canonical source. Its job is to stop mixed, stale, incomplete, or impossible data from silently flowing downstream.

## Canonical Scheduled Identity

The near-term scheduled identity is:

```text
symbol: BTC-USD
exchange: COINBASE
source: coinbase
quote: USD
```

Scheduled jobs and route helpers use `-USD` symbols for the canonical scheduled path, and the P9A deterministic scheduled regime path consumes persisted feature rows from that scheduled path. Explicit USDT markets such as `BTC/USDT`, `BTC-USDT`, and `BTCUSDT` are rejected at scheduled route boundaries instead of being silently converted to `BTC-USD`. `BTC/USDT` on Binance/TAAPI is a different market identity and is not equivalent to `BTC-USD` unless a future explicit normalization record says how the conversion was performed.

## Symbol Normalization Policy

`lib/dataQuality/marketIdentity.ts` normalizes common vendor forms such as `BTC`, `BTC-USD`, `BTC/USD`, `BTCUSDT`, `BTC-USDT`, and `BTC/USDT`.

Normalization is explicit:

- `BTC-USD + COINBASE + coinbase` resolves to the canonical scheduled identity.
- `BTC/USDT + BINANCE + taapi` resolves to `BTC-USDT`, quote `USDT`, source `taapi`.
- `BTC/USDT` does not silently equal `BTC-USD`; quote, exchange, and source mismatches produce block-level data-quality issues.
- When a vendor symbol is normalized, the identity records `normalizedFrom`.

## Bar Timestamp Convention

Bars use open timestamps. A 1H bar with `ts=2026-06-17T11:00:00.000Z` represents the interval `[11:00, 12:00)`.

Closed-bar enforcement uses that convention:

- If `now=12:05`, the `12:00` 1H bar is incomplete.
- The most recent trusted 1H bar is `11:00`.
- Daily bars must be aligned to `00:00:00.000Z`.

## Bar Quality Rules

`lib/dataQuality/barQuality.ts` validates bars before insert and before feature computation:

- Timestamp exists, parses as ISO, aligns to the timeframe, and is closed.
- `open`, `high`, `low`, and `close` are present, finite, and positive.
- `high >= low`.
- `open` and `close` are inside the high/low range.
- Volume is finite and non-negative when present.
- Missing volume blocks when `volumePolicy=required`.
- Missing volume is only usable when explicitly marked `optional_unavailable`, and then it is visible as a warning.
- Symbol, exchange, source, and timeframe are checked against the expected market identity.

`market.ingest.latest` skips blocked latest/incomplete bars when valid closed bars remain, but fails non-retryably if all fetched bars for a symbol are blocked.

## Feature Quality Rules

`lib/dataQuality/featureQuality.ts` validates persisted feature snapshots before they are consumed:

- Feature timestamp exists, parses as ISO, aligns to the source bar timeframe, and is closed.
- Feature symbol, exchange, and timeframe match the expected identity.
- `close` is present, finite, and positive.
- `featureVersion` is present.
- Numeric indicators are finite when present.
- RSI must remain in `[0, 100]`.
- ATR, ATR percent, candle range, and Bollinger geometry must not be impossible.
- 1H and 1D feature freshness are checked before trust.

## Freshness Thresholds

Defaults are intentionally conservative:

```text
DATA_QUALITY_1H_MAX_STALENESS_BARS=2
DATA_QUALITY_1D_MAX_STALENESS_BARS=2
```

If a 1H feature is older than two closed 1H bars, it is blocked. If a 1D feature is missing or stale, regime and strategy code can proceed only with visible reduced-context metadata and reliability caps.

## Enforcement Points

Quality gates now run at these trust boundaries:

- `market.ingest.latest`: validates fetched bars before insert.
- `features.compute`: validates stored bars before feature calculation.
- `regime.compute`: validates latest 1H and 1D feature snapshots before deterministic classification.
- `strategies.evaluate`: validates feature windows, latest 1H freshness, daily context freshness, and regime context freshness before signal generation.
- `dashboard.snapshot`: includes visible data-quality metadata for cache freshness and known provider/source mismatch risk.

## Regime Behavior

`regime.compute` does not call OpenAI.

If the 1H feature is missing, malformed, mismatched, incomplete, or stale:

- It persists a safe low-reliability `CHOP`.
- Trade permission maps through the existing reliability floor to `BLOCK`.
- The job succeeds with data-quality block metadata instead of throwing `regime_compute_no_output`.

If the 1D feature is missing or stale:

- The classifier may use 1H-only context.
- Reliability is capped at `0.55`.
- The result includes a reduced-context warning.

## Strategy Behavior

`strategies.evaluate` does not generate strategy signals from blocked feature windows.

If a symbol has no valid recent 1H features, or the latest 1H feature is stale, that symbol is skipped with a data-quality reason. The job still succeeds when all symbols are safely skipped for data-quality reasons. It should fail only for true system errors, invalid payloads, or storage failures.

If daily context is missing or stale, strategies run with reduced daily context and the result carries a warning.

## Dashboard Visibility

Dashboard refresh payloads now include:

```ts
{
  dataQuality: {
    severity,
    issues,
    symbols: {
      "BTC-USD": {
        market,
        barQuality,
        featureQuality,
        freshness
      }
    }
  }
}
```

The current dashboard cache still uses mixed TAAPI/Yahoo-style inputs for crypto display data. P9B surfaces this as warning metadata (`DASHBOARD_PROVIDER_MIXED_CONTEXT`) rather than implying that the cache is the canonical scheduled Coinbase feed.

The dashboard also warns when:

- Source bar open timestamps are not available from the cache.
- 1H cache freshness is stale.
- 1D context is missing or stale.
- Volume is unavailable.

## Remaining P9C Work

P9B does not rewrite historical rows and does not perform a full provider migration.

P9C should complete provider normalization by:

- Defining a durable normalization record for vendor symbols and quote conversions.
- Moving dashboard crypto data onto the same canonical scheduled identity or explicitly labeling any separate vendor context.
- Persisting source/data-source lineage with feature snapshots so feature rows can prove source, not only symbol/exchange/timeframe.
- Auditing existing TAAPI Binance `BTC/USDT`, Yahoo/dashboard `BTC-USD`, and Coinbase scheduled `BTC-USD` paths for complete separation or explicit conversion.
- Deciding whether historical mixed rows should be migrated, archived, or left readable but untrusted.

Until P9C, P9B prevents silent trust in mixed, stale, incomplete, or impossible data.
