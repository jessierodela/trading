# P9 Scheduled Pipeline Completion Report

## Canonical Scheduled Market

```text
symbol: BTC-USD
exchange: COINBASE
source: coinbase
quote: USD
```

Quote mismatches such as `BTC/USDT` or `BTC-USDT` are not silently converted into `BTC-USD`.

## OpenAI Boundaries

OpenAI is optional for dashboard display agents. Quota/auth/rate-limit failures fall back to deterministic dashboard behavior and are observable in `openai.strategyAgents.fallback` or `openai.regime.fallback`.

OpenAI is forbidden from the scheduled deterministic path:

```text
market.ingest.latest
features.compute
regime.compute
strategies.evaluate
paper.monitor
```

Scheduled regime classification uses deterministic persisted features.

## Provider Flow

```text
market.ingest.latest
  Coinbase REST, BTC-USD, COINBASE, USD

features.compute
  persisted market_bars with inherited source lineage

regime.compute
  persisted feature_snapshots with deterministic classifier

strategies.evaluate
  persisted feature windows plus latest regime context

dashboard.snapshot
  canonical scheduled metadata plus display-only dashboard provider warnings
```

## Quality Gates Before Trust

P9B checks:

```text
closed bar timestamp
valid OHLC values
impossible candle rejection
volume policy
feature timestamp alignment
1h and 1d freshness
market identity compatibility
scheduled BTC-USD vs BTC/USDT mismatch detection
```

P9C adds:

```text
durable source/vendor/quote metadata for new bars and features
source_lineage JSONB on bars/features/regimes/signals
feature-window lineage gates
read-only source-lineage audit
dashboard canonical/display boundary metadata
```

## Behavior On Bad Data

Bad or stale data does not become trusted clean data.

```text
Bad bars: blocked before insert unless the issue is explicitly warning-only.
Missing or stale 1h feature: regime.compute persists safe low-reliability CHOP.
Missing or stale 1d feature: regime.compute may proceed with reduced context and capped reliability.
Blocked strategy feature window: strategies.evaluate skips the symbol safely.
Dashboard mixed provider context: shown as warning/display-only metadata.
```

## Historical And Provider Risks

Existing historical rows may lack source lineage. They are treated as legacy/audit-only until a future explicit audit/backfill plan exists.

P9C does not fully migrate dashboard providers. The dashboard still may use display-only TAAPI/Yahoo-style context, but the payload no longer presents it as canonical scheduled Coinbase data.

## Operational Validation

Required validation set:

```bash
npm run smoke:source-lineage
npm run smoke:data-quality
npm run smoke:jobs
npm run smoke:pipeline-services
npm run smoke:job-worker
npm run smoke:route-jobs
npm run smoke:scheduler-bootstrap
npm run smoke:strategies
npm run smoke:backtest
npm run smoke:paper-trading
npm run scheduler:feed -- --once --dry-run
npm run build
git diff --check
```

Configured-environment checks:

```bash
npm run audit:source-lineage
npm run audit:source-lineage -- --strict
npm run validate:p8:operational
```

## Next Work

The remaining durable normalization work is optional follow-up, not a blocker for P9 scheduled trust boundaries:

```text
Add formal market_instruments/provider_symbols/source_lineage/normalization_policy tables if multi-provider normalization becomes active.
Choose dashboard Option A: migrate dashboard crypto data to canonical Coinbase BTC-USD.
Or choose dashboard Option B: keep TAAPI/Yahoo as display-only and label every panel accordingly.
Plan any historical lineage backfill as a separate read-only audit plus explicit migration.
```
