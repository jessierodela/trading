# P2 Cleanup — What Shipped

Address the reviewer's findings before P2B (ingestion) starts.

## Verification

Run from the project root:

```
npm install              # reconciles lockfile
npx tsc --noEmit         # clean
npm run lint             # non-interactive; 1 pre-existing warning in SignalsPanel.tsx
npm run build            # clean
npm audit                # 2 moderate (postcss XSS, not reachable). 0 critical, 0 high.
DATABASE_URL=... npm run smoke:storage   # 38/38 pass against in-memory + pg
```

## Changes

### 1. Lockfile reconciled (the big one)

`package-lock.json` now matches `package.json`. `next@15.5.18`, `pg@8.20.0`,
`tsx@4.22.0`, `@types/pg@8.20.0` all installed in the lockfile. Before this,
`npm ci` would fail because the lockfile was missing the deps you'd added
to `package.json`. After this, `npm ci` works.

`npm audit` is now:
- **0 critical** (was 1 in the reviewed bundle)
- **0 high** (was 0)
- 2 moderate — both postcss XSS in nested deps, not reachable in this codebase

The reviewer's "1 critical" result was specifically because the lockfile
hadn't been merged in their environment. This fixes that.

### 2. ESLint config (`.eslintrc.json`)

New file, two lines:

```json
{ "extends": "next/core-web-vitals" }
```

`npm run lint` now runs end-to-end without the interactive setup prompt.
Finds 1 pre-existing warning in `components/layout/SignalsPanel.tsx`
(react-hooks/exhaustive-deps) — that's in your code, not in scope here.

### 3. Migration: `create schema if not exists backtest`

Reviewer's suggestion. Lets the migration run safely against a Supabase
project where you've already created the `backtest` schema by hand.

Edited 0001 directly because nothing has applied it to production yet
(your live Supabase doesn't have it). After this point, the runner's
drift detection will catch any further edits to applied migrations.

### 4. RLS tightened on sensitive tables

Reviewer flagged that anon-readable `strategy_signals` and `agent_outputs`
would leak the desk's positioning logic if the anon key ever got exposed.
Fixed.

Anon SELECT is now allowed only on:
- `market_bars`
- `feature_snapshots`
- `regime_snapshots`

These are observable from the exchange and the regime detector outputs
respectively — leaking them costs nothing.

Anon SELECT is REVOKED on:
- `strategy_signals` (was: non-retracted readable)
- `agent_outputs` (was: non-alert readable)
- `trade_intents`, `orders`, `fills`, `positions`, `backtest.*` (already locked)

The Next.js dashboard, when it reads these later, must go through
service-role API routes. When you want to expose them, do it explicitly
in a future migration.

### 5. Confluence transition note

The reviewer (and I) worried that someone would build P3 strategies into
the old GPT-vote confluence by mistake. Added a top-of-file comment block
in `lib/confluence/confluenceEngine.ts` spelling out:

- This file is the LEGACY agent-vote scorer
- The TARGET (P4+) is a strategy arbitrator over deterministic signals
- Regime gating moves into the risk engine, not here
- Specifically: do NOT add `tradePermission`, `sizeMultiplier`,
  `edgeMultiplier` fields to confluence — those belong in
  `regime_snapshots` and the future risk engine. Confluence answers
  "do signals agree?". Risk answers "given they agree, trade how much?".

Pointer comment also added to `scoreSignals.ts`.

### 6. Application validators

New file `lib/storage/validators.ts` with `validateBar()` and
`validateFeatureSnapshot()`. Wired into the four `insert` methods on
both `PgBarStore`/`InMemoryBarStore` and `PgFeatureStore`/`InMemoryFeatureStore`.

What they catch:

- Missing or invalid timeframe
- Timestamp not parseable as ISO-8601 with timezone
- Bar timestamp not aligned to its timeframe boundary (e.g. 14:30 on a 1h bar)
- 1d bar not at 00:00 UTC
- Negative or zero OHLC prices
- NaN/Infinity in any numeric field
- OHLC sanity (high>=low, high>=open, high>=close, low<=open, low<=close)
- Negative volume
- Missing featureVersion stamp on features

What they DON'T catch:

- Domain plausibility (e.g. "RSI 0-100"). Clipping those here would mask
  real math bugs upstream. P2D cross-validation catches those.

Validators throw `ValidationError` with a descriptive message. Caught
a real bug in my own smoke test on first run — the test was constructing
malformed bars to trigger conflict scenarios.

### Files

```
.eslintrc.json                                 (new)
package-lock.json                              (reconciled with package.json)
migrations/0001_initial_schema.sql             (schema-if-not-exists, RLS tightening)
lib/confluence/confluenceEngine.ts             (transition note at top)
lib/confluence/scoreSignals.ts                 (legacy pointer at top)
lib/storage/validators.ts                      (new)
lib/storage/barStore.ts                        (validator wired in)
lib/storage/featureStore.ts                    (validator wired in)
lib/storage/index.ts                           (re-exports validators)
_smoke/storage.ts                              (12 new validator assertions; 38/38 total)
```

## What the reviewer asked for that I deliberately did NOT do

### `tradePermission` / `sizeMultiplier` / `edgeMultiplier` on confluence result

The reviewer suggested these as fields on `ConfluenceResult`. I declined
and made the boundary explicit via the transition note instead. Reasoning:
P1 ARCHITECTURE.md decided regime gating moves into the risk engine, not
confluence. Putting these fields on confluence confuses that line and we'd
end up removing them when the risk engine ships. The transition note
documents this so a future reader doesn't re-litigate.

### `PgIntentStore`, `PgOrderStore`, `PgFillStore`, `PgPositionStore`, `PgAgentOutputStore`

Reviewer noted these are missing. Correct — they are P6/P7 prerequisites,
not P2 prerequisites. The interfaces exist in `lib/storage/interfaces.ts`
for when those phases need them. Building them speculatively now means
rewriting when the actual query patterns are known.

### zod schema validation on agent JSON.parse

Reviewer dinged P0 for not having it. Original plan put zod under
"Priority 10 — Code Quality and Validation," not P0. The underlying
concern (agents parse without validation) is real and worth doing — but
deserves its own session, not a cleanup pass. Left as a flagged TODO for
a later sprint.

## What's next

Reviewer's recommended split holds:

- **P2B**: Coinbase REST historical backfill — 2 years of BTC 1h candles
  into `market_bars` via `PgBarStore.insertMany`, respecting rate limits
- **P2C**: local feature engine — compute RSI/MACD/EMA/ATR/BB locally over
  bar windows, write via `PgFeatureStore`, replacing TAAPI on the
  feature-compute path
- **P2D**: validate local feature values against TAAPI for a sample of
  recent bars (±0.5% tolerance), cut over when matching

Suggest P2B next. Getting real BTC bars into the DB is the first real
"the desk exists" milestone and unblocks everything downstream.
