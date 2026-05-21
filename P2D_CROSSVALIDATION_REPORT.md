# P2D — Feature Engine Cross-Validation Report

> P2D proves the local engine is internally deterministic and
> mathematically consistent, then uses TAAPI as an external
> cross-venue sanity check before the live cutover.

Local is **Coinbase BTC-USD**; TAAPI free plan is **Binance BTC/USDT**.
Different venues — this is a ballpark sanity check, not exact parity.

## Run metadata

- Local feature version: `features.2026-05-20.v3`
- TAAPI capture timestamp: 2026-05-21T03:31:58.216Z
- TAAPI symbol/exchange: BTC/USDT @ binance
- Local symbol/exchange: BTC-USD @ COINBASE
- Timeframe: 1h
- Sampled bars: 72
- Warmup bars before sample: 200
- Sample range: 2026-05-18T04:00:00.000Z → 2026-05-21T03:00:00.000Z

## Indicator-level results (TAAPI cross-venue comparison)

| Indicator | Sampled | Pass | Soft | Hard | Tolerance | Worst |abs diff| @ ts |
|-----------|--------:|-----:|-----:|-----:|-----------|------------------------|
| rsi14 | 72 | 72 | 0 | 0 | 2 points | 1.226 @ 2026-05-21T03:00:00.000Z |
| macd | 72 | 72 | 0 | 0 | 0.2500% of price | 6.421 @ 2026-05-18T19:00:00.000Z |
| macdSignal | 72 | 72 | 0 | 0 | 0.2500% of price | 5.222 @ 2026-05-19T18:00:00.000Z |
| macdHist | 72 | 71 | 1 | 0 | 0.2500% of price | 3.007 @ 2026-05-21T03:00:00.000Z |
| ema20 | 72 | 72 | 0 | 0 | 0.5000% of price | 84.21 @ 2026-05-21T03:00:00.000Z |
| ema50 | 72 | 72 | 0 | 0 | 0.5000% of price | 76.29 @ 2026-05-21T03:00:00.000Z |
| ema200 | 72 | 72 | 0 | 0 | 0.7500% of price | 517.5 @ 2026-05-18T04:00:00.000Z |
| atr14 | 72 | 72 | 0 | 0 | 0.3000% of price or 10.00% relative | 18.94 @ 2026-05-18T22:00:00.000Z |
| bbUpper | 72 | 72 | 0 | 0 | 0.7500% of price | 89.42 @ 2026-05-21T03:00:00.000Z |
| bbMiddle | 72 | 72 | 0 | 0 | 0.5000% of price | 83.10 @ 2026-05-21T03:00:00.000Z |
| bbLower | 72 | 72 | 0 | 0 | 0.7500% of price | 86.72 @ 2026-05-21T02:00:00.000Z |

## Hard failures

None.

## Soft findings (cross-venue outliers — documented, non-blocking)

| ts | indicator | local | reference | abs diff | reason |
|----|-----------|------:|----------:|---------:|--------|
| 2026-05-20T03:00:00.000Z | macdHist | -0.1301 | 0.5832 | 0.7133 | sign mismatch within magnitude tolerance (near zero crossing) |

## Internal validation (recomputed a second, naive way — not TAAPI)

- **Volume** (volumeSma20, relativeVolume20): PASS — 544/544 checks. Method: naive sum-of-last-20-non-null-volumes / 20; relativeVolume = volume / that. Volume is venue-specific and is never compared against TAAPI.
- **Bollinger** (bbUpper/Middle/Lower): PASS — 816/816 checks. Method: SMA20 ± 2·population stdev over last 20 closes.

## Recommendation

> **GO** — no hard failures. Soft findings documented above are
> explainable cross-venue differences. The local engine is cleared
> for the live pipeline cutover.

---

_P2D does NOT perform the live pipeline cutover — that is separately
gated on this report's recommendation._
