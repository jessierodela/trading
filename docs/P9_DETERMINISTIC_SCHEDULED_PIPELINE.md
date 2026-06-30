# P9 deterministic scheduled pipeline

P9 makes the scheduled production path safe when OpenAI is disabled, quota-limited, or missing an API key.

Default env posture:

```bash
OPENAI_ENABLED=false
OPENAI_REGIME_ENABLED=false
OPENAI_STRATEGY_AGENTS_ENABLED=false
```

With those defaults, the scheduled path is:

```text
market.ingest.latest -> features.compute -> regime.compute -> strategies.evaluate -> paper.monitor -> dashboard.snapshot
```

The path does not require `OPENAI_API_KEY`.

## OpenAI call site audit

| Path | Purpose | Scheduled-critical? | P9 change |
| --- | --- | --- | --- |
| `lib/jobs/handlers/regimeCompute.ts` | Previously called A6 GPT regime detector from persisted feature snapshots, then fell back to `runRegimeRefreshPipeline`. | Yes | Replaced with `classifyFeatureRegime`; persists deterministic rows with `aiUsed:false`; no OpenAI fallback. |
| `lib/jobs/worker.ts` | Previously injected GPT-linked regime services into worker services. | Yes | Removed default `runRegimeDetector` and `runRegimeRefreshPipeline` injection so the production worker service bag is deterministic for scheduled jobs. |
| `lib/pipeline/dashboardRefreshPipeline.ts` | Dashboard refresh previously ran A6 plus A1-A5 GPT agents. | Yes, through `dashboard.snapshot` | Added OpenAI env gates. Disabled/missing-key runs use deterministic `evaluateSignals` and deterministic regime classification. Enabled-but-failing OpenAI falls back without failing the snapshot. |
| `lib/confluence/confluenceEngine.ts` | Optional GPT narrative over deterministic confluence scores. | Yes, through `dashboard.snapshot` | `OPENAI_ENABLED=false` or missing key returns an `AI commentary skipped` narrative without calling OpenAI. |
| `lib/pipeline/regimeRefreshPipeline.ts` | On-demand regime refresh route/service using A6 GPT detector. | Optional/manual | Left intact. Not used by scheduled `regime.compute` after P9. |
| `lib/agents/regimeDetector.ts` | Legacy A6 GPT regime classifier. | Optional/manual | Left intact behind dashboard/on-demand gates. |
| `lib/agents/momentumScout.ts` | GPT Momentum Scout. | Optional/dashboard | Left intact; skipped by dashboard when strategy agents are disabled. |
| `lib/agents/breakoutWatcher.ts` | GPT Breakout Watcher. | Optional/dashboard | Left intact; skipped by dashboard when strategy agents are disabled. |
| `lib/agents/trendFollower.ts` | GPT Trend Follower. | Optional/dashboard | Left intact; skipped by dashboard when strategy agents are disabled. |
| `lib/agents/volatilityArbiter.ts` | GPT Volatility Arbiter. | Optional/dashboard | Left intact; skipped by dashboard when strategy agents are disabled. |
| `lib/agents/meanReversion.ts` | GPT Mean Reversion commentary for eligible symbols. | Optional/dashboard | Left intact; skipped by dashboard when strategy agents are disabled. |

## Regime compute behavior

`regime.compute` now reads persisted `feature_snapshots` and classifies with `lib/regime/deterministicRegimeClassifier.ts`.

The classifier returns:

- `regime`
- `confidence`
- `reason`
- `inputsUsed`
- `timestamp`
- `symbol`
- `source`
- `aiUsed:false`

Storage still uses the existing regime taxonomy. `RANGE` and `UNKNOWN` are persisted as safe `CHOP` rows because the database and permission map currently support `TREND_UP`, `TREND_DOWN`, `LOW_VOL`, `HIGH_VOL`, `CHOP`, and `NEWS_SHOCK`. `UNKNOWN` is capped at low reliability so `mapRegimeToPermission` blocks trading through the existing reliability floor.

`regime.compute` should fail only for real job failures, such as invalid payloads, storage errors, malformed data, or internal exceptions. Missing features are not a dead-letter condition; they persist a safe low-reliability fallback.

## Dashboard snapshot behavior

`dashboard.snapshot` can run with no OpenAI key:

- A6 uses deterministic regime classification when `OPENAI_REGIME_ENABLED` is false or the key is missing.
- A1-A5 use deterministic `evaluateSignals` when `OPENAI_STRATEGY_AGENTS_ENABLED` is false or the key is missing.
- If A1-A5 are enabled but OpenAI returns an optional provider failure, such as `429 insufficient_quota`, the dashboard falls back to deterministic `evaluateSignals` and records `openai.strategyAgents.fallback`.
- Confluence still scores deterministically.
- GPT narrative is replaced by an `AI commentary skipped` string when `OPENAI_ENABLED=false` or the key is missing.
- The response includes `openai.regime`, `openai.strategyAgents`, and `openai.confluenceNarrative` status for review.

Optional OpenAI failures are represented with `OptionalOpenAIError`. The dashboard catches that type and falls back deterministically. Unexpected non-OpenAI exceptions are not swallowed by the fallback path.

## Symbol/data-source risk

This change does not attempt to normalize the existing TAAPI Binance `BTC/USDT` and dashboard/Yahoo `BTC-USD` mismatch. P9 only avoids making that mismatch worse: deterministic scheduled `regime.compute` consumes the symbol and feature rows already persisted by the scheduled feature path, and the dashboard fallback consumes the current cache keys. A later data normalization task should reconcile symbol aliases and source lineage end-to-end.

## Validation notes

Focused P9 coverage:

- `smoke:job-worker` proves `regime.compute` succeeds without `OPENAI_API_KEY`, does not call an injected OpenAI detector that throws `429 insufficient_quota`, and persists a safe `CHOP` row for missing features.
- `smoke:pipeline-services` proves dashboard refresh succeeds with OpenAI disabled, avoids injected OpenAI agent functions, reports skipped OpenAI status, and also covers the enabled/dummy-key/quota-failure path where A1-A5 throw `OptionalOpenAIError` and deterministic strategy fallback is used.

Full validation should include the commands listed in the P9 task spec before review.
