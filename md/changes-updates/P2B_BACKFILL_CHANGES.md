# P2B Backfill — What Shipped

POST `/api/backfill/btc` that ingests 1 year of BTC-USD 1h candles from
Coinbase Exchange REST into `market_bars`, then rolls up to 1d locally and
inserts those too. Idempotent. Resumable if the Vercel time budget gets hit.

## Validation

```
npx tsc --noEmit       # clean
npm run build          # clean — /api/backfill/btc shows in route manifest
npm run smoke:backfill # 34/34 pass (column-order, oversize-gate, error
                       # paths, rollup math, partial-period gate, null-volume
                       # handling, mixed-symbol guard)
npm run smoke:storage  # still 38/38 (no regression)
npm run lint           # 1 pre-existing SignalsPanel warning, unchanged
```

## Files

### New

```
lib/data/coinbaseRest.ts            (REST client, no Next/Vercel deps)
lib/data/rollup.ts                  (1h → 1d aggregation)
app/api/backfill/btc/route.ts       (POST endpoint)
_smoke/backfill.ts                  (34 assertions, no DB needed)
```

### Modified

```
package.json                        (added smoke:backfill script)
```

`DATA_SOURCE_COINBASE_REST` was already exported from `lib/versions.ts`
(P2A baked it in anticipating this). The route imports it directly — every
bar inserted is stamped `coinbase.rest.v1`.

## How to use

```bash
# Default: last 365 days, BTC-USD 1h, with 1d rollup. Most calls look like this.
curl -X POST https://your-app.vercel.app/api/backfill/btc

# Specific range — useful for backfilling a single missing window
curl -X POST https://your-app.vercel.app/api/backfill/btc \
  -H "Content-Type: application/json" \
  -d '{"startTs": "2026-01-01T00:00:00Z", "endTs": "2026-02-01T00:00:00Z"}'

# Drop the partial last day (e.g. if backfilling for backtest where you
# don't want a 7-bar daily polluting Jan 1)
curl -X POST https://your-app.vercel.app/api/backfill/btc \
  -d '{"requireFullDay": true}'
```

Response shape:

```json
{
  "ok":             true,
  "symbol":         "BTC-USD",
  "timeframe":      "1h",
  "requestedRange": { "startTs": "...", "endTs": "..." },
  "fetchedBars":    8760,
  "insertedBars1h": 8760,
  "insertedBars1d": 365,
  "windows":        30,
  "durationMs":     14823,
  "dataSourceVersion": "coinbase.rest.v1"
}
```

If the time budget is hit (default 45s) before the range completes, a
`resumeCursor` field appears with the ISO timestamp to pass back as the
next `startTs`. For 1 year of 1h bars this should be one call.

## Design decisions worth flagging

### 1. pg pool from a Vercel route, despite the architecture preferring supabase-js

ARCHITECTURE.md §4 says Vercel reads go through supabase-js (REST), Railway
worker uses pg. Backfill is neither — it's a write-heavy bulk operation
on Vercel. I used pg via `getPgPool()` because:

- `PgBarStore.insertMany()` is one query for ~3000 rows. supabase-js would
  be ~30 REST round-trips. Worth eating the cold-start reconnect cost.
- Backfill is rare (once per asset, plus gap-filling) — connection pool
  churn doesn't matter at this cadence.

If this turns out to bite us under Supabase's connection limit, the switch
to `supabase-js` is mechanical (replace `bars.insertMany()` with a batched
`from('market_bars').insert(...)`).

### 2. Soft time budget instead of streaming

Vercel Pro caps at 60s. The route stops fetching at 45s elapsed and returns
a resume cursor. The 15s headroom covers the final insert + JSON
serialization + Coinbase tail-latency variance.

I considered streaming (write-as-you-fetch instead of collect-then-write)
but rejected it. The single bulk insert at the end is dramatically faster
than per-window inserts, and the boundary-deduplication step is much
simpler when all bars are in one array. Worst case at 1y/1h is one resume
call; not worth the complexity.

### 3. Idempotent inserts via onConflict='ignore'

Calling backfill twice with overlapping ranges is safe — no duplicates,
no errors. This is critical because:

- Gap-filling after a WS disconnect will overlap with already-stored bars
  at the boundaries.
- Retrying a failed backfill should not require manual cleanup.

The unique constraint on `market_bars(symbol, exchange, timeframe, ts)`
plus `on conflict do nothing` makes the operation safe to repeat.

### 4. Daily rollup happens locally, not via a second Coinbase call

Two reasons:

- Halves the number of REST calls during backfill.
- The daily bar is then a deterministic function of the hourly bars we
  stored. If the hourly bars are correct, the daily bars are correct.
  No risk of Coinbase's 1d aggregation disagreeing with our 1h sum (a
  problem we hit with TAAPI's volume SMA).

The rollup math is pure (no I/O), tested with 9 assertions in the smoke
test, and lives in `lib/data/rollup.ts` for reuse when 1m → 5m → 15m etc.
become real after WebSocket ingestion lands.

### 5. Column-order trap captured in one place

Coinbase returns tuples as `[time, low, high, open, close, volume]` — NOT
the OHLC ordering you'd expect. The mapping from raw tuple to `Bar` lives
in exactly one function (`rawToBar` in `coinbaseRest.ts`) with a comment
flagging the issue. Smoke test verifies the mapping explicitly so a future
edit can't silently swap fields.

## What was NOT done

### Auth on the route

Per agreed scope: open for now. Wired uniformly across all mutation
endpoints in P6 alongside the risk engine. Until then, treat any deployed
URL (including Vercel preview URLs) as a public endpoint and don't expose
publicly.

### Live Coinbase smoke test

The smoke test stubs `fetch` — it verifies the column-order mapping, error
handling, rollup math, and the oversize-window pre-flight gate, but it
doesn't actually hit Coinbase. To verify against the live API:

```bash
DATABASE_URL=postgres://...
curl -X POST https://your-app.vercel.app/api/backfill/btc \
  -d '{"startTs":"2026-05-13T00:00:00Z","endTs":"2026-05-14T00:00:00Z"}'
```

Expected: 24 bars inserted at 1h, 1 bar at 1d, response in ~2-3s. Re-run
the same call — should see `insertedBars1h: 0, insertedBars1d: 0` (idempotent
behavior confirmed).

### Migration application

This route assumes the schema from `migrations/0001_initial_schema.sql`
is applied. If you haven't run `npm run migrate` against your Supabase yet,
do that first. Route returns a clean pg error if `market_bars` doesn't
exist — not a crash, but not useful either.

### Rate-limit retry / backoff

Coinbase doesn't publish a strict rate limit on /candles and the 200ms
gap between paginated requests (5 req/s) is well under what the public
API tolerates. If we hit a 429, the route returns a 502 with the partial
result and the cursor of where it got to — caller decides whether to wait
and retry. This is correct behavior for a manually-invoked backfill;
auto-retry belongs in the WS reconnect path, not here.

## What's next

P2C — local feature engine. Read bars from `market_bars` via
`PgBarStore.fetchRange`, compute RSI/MACD/EMA/ATR/BB locally, write via
`PgFeatureStore.insertMany` with `FEATURE_VERSION` from `lib/versions.ts`.
The bar data this route ingests is the input.

P2D — cross-validate local features against TAAPI for a sample of recent
bars (±0.5% tolerance). When matching, cut the live pipeline over.
