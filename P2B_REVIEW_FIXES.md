# P2B Review Fixes — What Shipped

Addresses the reviewer's P2B_BACKFILL_IMPLEMENTATION_REVIEW.md findings.

## Validation

```
npx tsc --noEmit               # clean
npm run build                  # clean — /api/backfill/btc in route manifest
npm run smoke:backfill         # 40/40 (was 34/34 — +6 new assertions)
npm run smoke:storage          # 38/38 — no regression
npm run lint                   # 1 pre-existing SignalsPanel warning, unchanged
npm audit --omit=dev           # 0 critical, 0 high, 2 moderate (unchanged,
                               # postcss XSS in nested deps, not reachable)
```

## What changed vs. the reviewed bundle

### MUST-FIX items from review

**1. package.json `next` version pin** — Reviewer flagged this as a regression.
It wasn't a P2B regression (it's been this way since before P2A — P0 notes
acknowledged it), but the underlying concern is right. Pinned:

```diff
- "next": "^15.1.9",
- "eslint-config-next": "15.1.0"
+ "next": "15.5.18",
+ "eslint-config-next": "15.5.18"
```

`npm install` reconciled the lockfile to match. Both pins now exact.

**2. Partial 1d bars become permanent** — Reviewer's most important finding.
This was a real bug. The route truncated `endTs` to the current UTC HOUR, not
the current UTC DAY, so a partial daily bar would get written and then locked
in by `onConflict='ignore'` on subsequent runs.

Fixed with two-layer defense:

- **Route-level**: `requireFullDay` defaults to `true`. When true, bars from
  the in-progress UTC day are filtered out *before* the rollup runs. This
  is explicit in the route flow with a clear comment.
- **Rollup-level**: passing `requireFullPeriod: true` drops any day with
  fewer than 24 hourly source bars. Catches the edge case at the start of
  a backfill range too.

Either layer alone catches the original bug. Both is cheap and the
defense-in-depth is worth it for backtest-grade data.

Rejected the reviewer's alternative suggestion of upsert/update semantics —
upsert would *replace* the partial daily with the full daily, but it would
also let bad data sneak in if someone passed `requireFullDay: false`. Refusing
to write the partial is the cleaner invariant.

**3. Open mutation endpoint** — Added interim secret-header guard:

```ts
if (!process.env.BACKFILL_SECRET) return 503;        // loud misconfig
if (req.headers.get("x-backfill-secret") !== process.env.BACKFILL_SECRET) return 401;
```

Not real auth — it's a shared-secret door. The goal is to keep a stranger who
finds a Vercel preview URL from triggering DB writes / Coinbase burst traffic.
Replaced by uniform P6 auth alongside the risk engine.

Note: route refuses to run if `BACKFILL_SECRET` is unset rather than failing
open. Loud misconfig is better than silent expose.

**4. Clamp `timeBudgetMs`** — `Math.max(1000, Math.min(rawBudget, 55_000))`.
Floor prevents degenerate no-ops; ceiling prevents callers from setting a
budget the Vercel function would never honor.

**5. `startMs >= endMs` guard inside `fetchCandleWindow`** — Added. The public
helper now enforces its own contract instead of relying on the route to do it.

### SHOULD-FIX items from review

**6. Validate every Coinbase tuple, not just the first** — Done. The old
"sample-first" check missed partial API drift (first tuple valid, second
malformed). Smoke test now covers this case explicitly. Also tightened the
per-value check to `Number.isFinite()` so `NaN`/`Infinity` is rejected.

**7. Live DB smoke test** — Added `npm run smoke:backfill:live`:

- Requires `DATABASE_URL` (or `SUPABASE_DB_URL`).
- Hits the real Coinbase REST API.
- Picks a deterministic 26-hour window 2 days in the past (fully closed,
  safe to rerun).
- Inserts via `PgBarStore`, then re-inserts and asserts idempotency.
- Queries back to verify rows landed.
- Compares the 1d rollup OHLC to the 24 source 1h bars for the target day.

This is NOT a test of the HTTP route layer (auth header, JSON parsing,
NextResponse) — that surface is thin and gets exercised by curl below.
It IS the missing end-to-end test of the ingestion path.

**8. 2-year bootstrap** — Reviewer noted the plan acceptance criterion says
"at least 2 years" but the route defaults to 365 days.

The route default reflects the user's explicit P2B-scoping choice ("1 year,
faster smoke test"). Rather than override that, added `scripts/backfillBtcBootstrap.ts`
with `npm run backfill:btc:bootstrap`:

```bash
BACKFILL_URL=https://your-app.vercel.app \
BACKFILL_SECRET=... \
YEARS=2 \
npm run backfill:btc:bootstrap
```

Walks the range in 60-day chunks, drives the route N times, honors `resumeCursor`,
fully idempotent. The route stays flexible (`startTs` settable for arbitrary
windows); the script handles long-range bootstrapping. Meets the plan
criterion without burying the user's choice.

**9. Unsorted-input guard in `rollupBars`** — Done. Throws on duplicate or
descending timestamps rather than silently sorting. The reviewer correctly
identified that silent sorting would mask upstream bugs (e.g. a fetch that
forgot to reverse Coinbase's descending tuples). Quant-grade defensiveness
should fail loudly.

**11. `export const dynamic = "force-dynamic"`** — Done. Plus
`export const revalidate = 0`. Mutation routes should never be cached.

### Pushed back on one item

**10. Dedup with full bar identity key** — Reviewer suggested
`${symbol}|${exchange}|${timeframe}|${ts}` instead of just `ts`. Declined.
The route is hardcoded to BTC-USD/COINBASE/1h in three places. Adding a
composite key now is speculative defense against a generalization that
doesn't exist; the cost is the next reader wondering why the key has fields
that are always constant. If/when the route accepts symbol as a parameter,
the key grows then.

If the helper is later extracted into a general utility (which would be the
right move when P2C or beyond needs it), the composite key comes along
with that extraction.

## New & changed files

```
NEW:
  _smoke/backfill_live.ts                  (real Coinbase + DB integration test)
  scripts/backfillBtcBootstrap.ts          (2y bootstrap walker)
  P2B_REVIEW_FIXES.md                      (this doc)

MODIFIED:
  package.json                             (pinned next/eslint-config-next exactly;
                                            added smoke:backfill:live & backfill:btc:bootstrap scripts)
  package-lock.json                        (reconciled to 15.5.18 pin)
  app/api/backfill/btc/route.ts            (secret guard, requireFullDay=true default,
                                            in-progress-day filter, timeBudget clamp,
                                            force-dynamic, updated docstring)
  lib/data/coinbaseRest.ts                 (validate every tuple, finiteness check,
                                            startMs>=endMs guard inside helper)
  lib/data/rollup.ts                       (throw on unsorted/duplicate-ts input)
  _smoke/backfill.ts                       (+6 new assertions: partial drift,
                                            non-finite, range guard, no-fetch on range,
                                            unsorted throw, duplicate-ts throw)
```

## How to verify locally

```bash
npm install                          # picks up pinned versions
npx tsc --noEmit                     # must be clean
npm run build                        # must be clean
npm run smoke:backfill               # 40/40
npm run smoke:storage                # 38/38

# Live verification — set BACKFILL_SECRET in .env.local and DATABASE_URL.
DATABASE_URL=postgres://... npm run smoke:backfill:live
# Expected: 12 PASS lines, no FAIL.

# Then deploy and run the 2-year bootstrap:
BACKFILL_URL=https://your-app.vercel.app \
BACKFILL_SECRET=... \
YEARS=2 \
npm run backfill:btc:bootstrap
# Expected: ~13 chunks of 60 days each, ~15s per chunk → ~3-4 min total
```

## P2 status update

| Plan acceptance criterion                                       | Status |
|-----------------------------------------------------------------|--------|
| Can ingest at least 2 years of BTC historical candles           | ✅ via bootstrap script |
| Can calculate all current indicators locally                    | ⬜ P2C |
| Can reproduce latest feature snapshot without TAAPI             | ⬜ P2C / P2D |
| Every feature row has symbol/timeframe/timestamp/version        | ✅ (P2A enforces via validator) |

P2B is now substantively complete. Next: P2C — local feature engine reading
from `market_bars`, computing RSI/MACD/EMA/ATR/BB locally, writing
`feature_snapshots` with `FEATURE_VERSION`.
