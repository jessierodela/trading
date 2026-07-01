# P9C Provider Normalization and Source Lineage

## Scope

P9C adds durable source-lineage metadata for new scheduled pipeline rows. It does not rewrite historical rows and it does not migrate every provider to a single canonical feed.

The canonical scheduled market remains:

```text
symbol: BTC-USD
exchange: COINBASE
source: coinbase
quote: USD
```

`BTC-USDT`, `BTC/USDT`, and `BTCUSDT` remain separate Binance/TAAPI-style quote contexts unless a future explicit normalization policy records the conversion.

## New Lineage Fields

The additive migration `0004_source_lineage.sql` adds:

```text
market_bars.source
market_bars.vendor_symbol
market_bars.quote_asset
market_bars.source_lineage

feature_snapshots.source
feature_snapshots.vendor_symbol
feature_snapshots.quote_asset
feature_snapshots.source_lineage

regime_snapshots.source_lineage
strategy_signals.source_lineage
```

Historical rows are not rewritten. Rows without lineage are surfaced as legacy/audit-only warnings.

## Market Model

The shared market helpers live under `lib/market`:

```text
types.ts
marketInstrument.ts
providerSymbol.ts
normalizationPolicy.ts
sourceLineage.ts
```

They reuse the P9B market identity parser in `lib/dataQuality/marketIdentity.ts`.

The rule is intentionally conservative:

```text
BTC-USD / COINBASE / coinbase / USD
```

is not equivalent to:

```text
BTC-USDT / BINANCE / taapi / USDT
```

Source-lineage gates block proven quote/exchange/symbol mismatches and warn on missing legacy lineage.

## Pipeline Propagation

`market.ingest.latest` attaches lineage to trusted bars after bar quality passes.

`features.compute` inherits lineage from source bars, creates feature-snapshot lineage, and blocks mixed USD/USDT windows before computing features.

`regime.compute` includes feature lineage in `rawResponse` and persists derived regime lineage. If lineage is blocked, it follows the P9B safe fallback behavior: low-reliability CHOP rather than a confident trend.

`strategies.evaluate` validates feature-window lineage before running strategies. Blocked windows are skipped safely. Persisted strategy signals include derived strategy-signal lineage.

`dashboard.snapshot` exposes `marketContext`:

```text
canonicalScheduled: trusted Coinbase BTC-USD scheduled identity
dashboardDisplay: display-only TAAPI/Yahoo-style non-canonical context
```

This keeps the dashboard honest while allowing the current display feed to remain temporarily mixed.

## Audit

Run:

```bash
npm run audit:source-lineage
```

Default mode is read-only/report-only. It reports:

```text
missing source_lineage rows
missing lineage columns
canonical BTC-USD rows carrying USDT quote/vendor metadata
```

Strict mode fails on block issues. Legacy rows without lineage remain warning-only unless a future policy explicitly requires historical backfill:

```bash
npm run audit:source-lineage -- --strict
```

or:

```bash
SOURCE_LINEAGE_STRICT=1 npm run audit:source-lineage
```

## Validation

The focused smoke is:

```bash
npm run smoke:source-lineage
```

It proves:

```text
Coinbase BTC-USD stays USD
TAAPI BTC/USDT stays USDT
BTC/USDT does not silently equal BTC-USD
market ingest stores lineage
feature compute derives lineage
mixed USD/USDT lineage blocks trust
legacy missing lineage warns
features.compute blocks mixed persisted lineage
regime.compute persists derived lineage
strategies.evaluate persists derived signal lineage
dashboard exposes canonical/display boundary
audit report-only and strict summaries work
no live execution job types were introduced
```

## Remaining Risks

P9C still does not perform a full provider migration. Known follow-ups:

```text
Add durable market_instruments/provider_symbols/normalization_policy tables if multi-provider normalization becomes active.
Persist full source lineage for any dashboard-only provider rows if those rows become trusted pipeline inputs.
Run a read-only audit against production after migration.
Decide whether dashboard crypto data should move fully to Coinbase BTC-USD or remain labeled display-only.
Do not backfill historical lineage without an explicit audit and migration plan.
```
