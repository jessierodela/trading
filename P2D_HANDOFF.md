# P2D Handoff - Feature Engine Cross-Validation (for Engineer + PM review)

**Date:** 2026-05-21 | **Repo:** `jessierodela/trading` | **Phase:** P2D
**Verdict:** **GO on the committed offline fixture/report** - local engine is cleared by the captured P2D evidence. The live pipeline cutover remains a separate, gated change.

---

## 1. TL;DR

P2D proves the local P2C feature engine is internally deterministic and mathematically self-consistent, then uses TAAPI as an external cross-venue sanity check before cutting the live signals pipeline off TAAPI.

The committed P2D fixture/report validates cleanly: **0 hard failures** across all 11 price-derived indicators, with a single explainable soft finding.

> Cross-venue framing: local is **Coinbase BTC-USD**, TAAPI free plan is **Binance BTC/USDT**. This is a ballpark sanity check, **not** exact parity. `FEATURE_VERSION` was not changed by P2D; P2D validates the P2C v3 engine.

Important review note: the committed offline evidence is green. A fresh live re-run from Codex on 2026-05-21 reached DB + TAAPI but stopped on repeated TAAPI `429` rate limits, so the handoff should not claim that the latest local live re-run succeeded.

---

## 2. Latest Commit Reviewed

```text
commit e81b52684ff24a885ef91460967923a3fc9bce3a
branch ai/p2d-cross-validation
P2D: real TAAPI cross-validation fixture + GO report
```

**Files (3 changed, +13,016 / -13):**

| File | Change |
|------|--------|
| `fixtures/p2d/btc_1h_crossvalidation_fixture.json` | NEW (~12.9k lines) - self-contained real capture: frozen bars + frozen features + TAAPI reference. |
| `P2D_CROSSVALIDATION_REPORT.md` | NEW - generated from the successful live capture; explicit GO. |
| `_smoke/features_crossvalidate_live.ts` | Adjusts the live harness to cap the sample at TAAPI's current candle when local data runs ahead of TAAPI's latest close. |

---

## 3. Cross-Validation Results From Committed Fixture

Sample window `2026-05-18T04:00Z -> 2026-05-21T03:00Z` - **72 bars** + **200-bar warmup**, feature version `features.2026-05-20.v3`. Captured against the live DB and TAAPI free tier in the committed report.

| Indicator | Sampled | Pass | Soft | Hard | Tolerance | Worst abs diff |
|-----------|--------:|-----:|-----:|-----:|-----------|---------------:|
| rsi14 | 72 | 72 | 0 | 0 | 2 points | 1.226 |
| macd | 72 | 72 | 0 | 0 | 0.25% of price | 6.421 |
| macdSignal | 72 | 72 | 0 | 0 | 0.25% of price | 5.222 |
| macdHist | 72 | 71 | 1 | 0 | 0.25% of price | 3.007 |
| ema20 | 72 | 72 | 0 | 0 | 0.50% of price | 84.21 |
| ema50 | 72 | 72 | 0 | 0 | 0.50% of price | 76.29 |
| ema200 | 72 | 72 | 0 | 0 | 0.75% of price | 517.5 |
| atr14 | 72 | 72 | 0 | 0 | 0.30% of price or 10% relative | 18.94 |
| bbUpper | 72 | 72 | 0 | 0 | 0.75% of price | 89.42 |
| bbMiddle | 72 | 72 | 0 | 0 | 0.50% of price | 83.10 |
| bbLower | 72 | 72 | 0 | 0 | 0.75% of price | 86.72 |

- **TAAPI timestamp coverage in committed fixture:** 72 / 72.
- **Hard failures:** 0.
- **Soft findings:** 1 - `macdHist` sign flip at a near-zero crossing on `2026-05-20T03:00Z` (local `-0.1301` vs Binance `0.5832`). This is the documented, expected cross-venue case and is non-blocking.
- **Internal naive recompute:**
  - Volume (`volumeSma20`, `relativeVolume20`): **544 / 544 PASS**
  - Bollinger (`bbUpper/Middle/Lower`): **816 / 816 PASS**

---

## 4. Verification Status

### Verified by Codex on exact commit `e81b52684ff24a885ef91460967923a3fc9bce3a`

| Check | Result |
|-------|--------|
| `npm.cmd run smoke:p2d` | PASS - 19 / 19 |
| `npm.cmd run smoke:features` | PASS - 71 / 71 |
| `npm.cmd exec tsc -- --noEmit` | PASS |
| `npm.cmd run smoke:p2d:live` | Reached DB and TAAPI, then STOPPED after repeated TAAPI `429` rate limits on the first bulk request |

Latest live attempt details from Codex:

```text
sample window: 2026-05-18T04:00:00.000Z -> 2026-05-21T03:00:00.000Z
sample needs backtracks 14..85
TAAPI request 1/8: backtrack 14..23
STOP - TAAPI bulk request kept getting rate limited after retries
```

### Reported by PR author / committed evidence, not independently re-run in the latest Codex pass

| Check | Status |
|-------|--------|
| Original successful `smoke:p2d:live` capture | Represented by committed fixture + `P2D_CROSSVALIDATION_REPORT.md` |
| `smoke:storage` | Reported passing in PR body |
| `npm run build` | Reported clean in PR body |
| `npm run lint` | Reported only pre-existing `SignalsPanel` warning in PR body |

`smoke:p2d` recomputes features from the frozen fixture bars and asserts they match frozen `localFeatures` bit-for-bit. If engine math changes later, this fails loudly and the fixture must be re-captured.

---

## 5. What Shipped on the P2D Branch

Branch `ai/p2d-cross-validation` (4 commits, stacked on `ai/p2c-feature-engine`):

```text
e81b526  P2D: real TAAPI cross-validation fixture + GO report
63aafd1  P2D: align live capture to TAAPI backtrack offset + reachability guard
34f5d3f  P2D: accept TAAPI_KEY or TAAPI_API_KEY in live capture
b1e6564  P2D: cross-validation core + offline/live harness (pre-capture)
```

| File | Purpose |
|------|---------|
| `lib/features/crossValidate.ts` | Pure comparison core. Indicator-specific tolerances, hard/soft classification with >10% per-indicator systematic escalation, and internal naive recompute for volume + Bollinger. |
| `_smoke/features_crossvalidate.ts` (`smoke:p2d`) | Offline deterministic test: 13 comparator unit tests + fixture-driven validation. |
| `_smoke/features_crossvalidate_live.ts` (`smoke:p2d:live`) | Live capture: picks freshest TAAPI-reachable contiguous 272-bar window, fetches TAAPI historicals, writes fixture only under `UPDATE_P2D_FIXTURE=true`, generates the report. |
| `fixtures/p2d/btc_1h_crossvalidation_fixture.json` | Real captured data. |
| `P2D_CROSSVALIDATION_REPORT.md` | Generated GO report. |
| `package.json` | Added `smoke:p2d`, `smoke:p2d:live`. |

---

## 6. Pull Requests

| PR | Title | Head -> Base | State |
|----|-------|--------------|-------|
| [#1](https://github.com/jessierodela/trading/pull/1) | P2C: feature engine with gap detection | `ai/p2c-feature-engine` -> `main` | OPEN |
| [#2](https://github.com/jessierodela/trading/pull/2) | P2D: feature engine cross-validation against TAAPI (GO) | `ai/p2d-cross-validation` -> `ai/p2c-feature-engine` | OPEN |

PR #2 is stacked on PR #1 so its diff shows only P2D changes. After #1 merges to `main`, rebase or retarget PR #2 to `main`.

---

## 7. Cleanup Applied Before Merge

The final P2D cleanup fixes the live harness reachability edge:

- The guard now accounts for the exact range fetched from TAAPI: `SAMPLE_BARS + BACKTRACK_BUFFER`.
- The committed default `P2D_BACKTRACK_CHUNK` is now `2`, with env override support preserved.
- Offline smoke coverage now asserts both the default chunk and the buffered reachability guard.

This does not change the committed fixture/report result; it makes future live recaptures safer and more aligned with the free-tier workflow.

---

## 8. Operational Notes for the Engineer

- **TAAPI free-tier limits (empirical):**
  - Per-request calculation cap appears low enough that smaller chunks are safer. The committed default is now `P2D_BACKTRACK_CHUNK=2`; the env override remains available for explicit tuning.
  - Backtrack reach is about **270 hourly candles** (~11 days): backtrack 270 OK, 290 empty. The live script reachability guard includes `BACKTRACK_BUFFER`, matching the actual fetch range.
  - Rate: roughly 1 request / 15s. With `P2D_BACKTRACK_CHUNK=2`, a full 72-bar capture is around 40 requests and roughly 10 minutes wall time. The old chunk=10 path was more likely to trip free-tier throttling and is no longer the default.
- **Re-capture command when engine math changes:**

```powershell
$env:UPDATE_P2D_FIXTURE='true'
# Optional; this is now the default, but kept here for explicit recaptures.
$env:P2D_BACKTRACK_CHUNK='2'
npm.cmd run smoke:p2d:live
```

- **Env:** `.env.local` (gitignored) needs `TAAPI_API_KEY` or `TAAPI_KEY`, plus `SUPABASE_DB_URL` or `DATABASE_URL`.
- If a Supabase pooler password contains `@`, percent-encode it as `%40` in the URI.
- **Capture prep reported in PR:** recent backfill was extended to current via Coinbase REST so the post-gap segment exceeds 272 contiguous bars. This prep was not part of the committed P2D code.

---

## 9. Open Follow-Up (Out of P2D Scope)

- **Coinbase source data gap.** A genuine 5-bar hole exists in Coinbase's BTC-USD 1h data at `2026-05-08T02:00Z-06:00Z` according to the PR notes. It sits behind the P2D warmup and did not affect the committed results. Recommend adding gap monitoring to the backfill path (reuse `lib/features/gaps.ts`) so source holes are surfaced loudly, and document this known gap.

---

## 10. Next Step

P2D's committed GO evidence clears the live pipeline cutover design-wise: point the signals path at `feature_snapshots` instead of TAAPI. That cutover is a separate change, intentionally **not** performed in P2D.

The final cleanup fixed the `BACKTRACK_BUFFER` reachability guard and defaulted the live capture chunk size to 2. Future live recaptures remain TAAPI-rate-limit sensitive.


