# P5 Current-State Report Audit

Generated: 2026-06-03T03:06:27.568Z

Note: source versioned P5 reports are local research artifacts and may not be committed to git. This comparison stores the extracted sections needed for review.

## Compare Mode

`P5_COMPARE_MODE=current` was used, so this report extracts the latest/current P5 multi-asset report first and still checks expected historical snapshots for missing-source warnings.

Current report source: `P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md`.

## Compared Reports

| label | report | Strategy Refinement Candidate Comparison | Strategy Refinement Candidate Results | Cross-Asset Validated Candidate Summary | Cross-Asset Router Validation Summary | Gate Availability Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| current-latest | P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md | yes | yes | yes | yes | yes |
| baseline | missing | no | no | no | no | no |
| breakout8c | missing | no | no | no | no | no |
| trend8d | missing | no | no | no | no | no |
| mean8e | missing | no | no | no | no | no |
| results8f | missing | no | no | no | no | no |
| reporting-hardening | missing | no | no | no | no | no |

## Missing Snapshot Warnings

WARNING: one or more expected report snapshots were missing. Extracted comparisons for those snapshots are incomplete.

- baseline: no report matched expected snapshot 'baseline'
- breakout8c: no report matched expected snapshot 'breakout8c'
- trend8d: no report matched expected snapshot 'trend8d'
- mean8e: no report matched expected snapshot 'mean8e'
- results8f: no report matched expected snapshot 'results8f'
- reporting-hardening: no report matched expected snapshot 'reporting-hardening'

## Current Conclusion

- No refined strategy candidate should be treated as validated edge from the current report set.
- `momentum_continuation_refined_v1` improved quality metrics but failed rolling-fold validation.
- `trend_pullback_refined_v1` appears over-filtered and needs either looser research gates or more qualifying samples before any edge claim.
- `breakout_expansion_refined_v1` remains not validated.
- `mean_reversion_refined_v1` underperforms in the current held-out/refinement evidence.

## Priority 8G Implementation Completeness Audit

| priority item | status | evidence | remaining gap | next action |
| --- | --- | --- | --- | --- |
| Cross-Asset Opportunity Walk-Forward Validation exists | complete | Cross-Asset Opportunity Walk-Forward Validation section extracted from versioned P5 reports | Candidate-level validation is still directional and sample-limited | Keep using held-out plus rolling folds before treating opportunities as edge |
| Reusable strategy refinement / gating framework exists | complete | Refined variants, gate diagnostics, and base-vs-refined report sections are present | Gate diagnostics are report-level observability, not a replacement for causal strategy research | Keep framework stable while planning v3 experiments |
| momentum_continuation_refined_v1 exists, is versioned, registered, and smoke-tested | complete | Appears in refinement comparison/results, strategy versions, and momentum test-pass breakdown | Improved quality metrics but failed rolling folds | Keep as main v3 investigation candidate; do not promote |
| breakout_expansion_refined_v1 exists, is versioned, registered, and smoke-tested | complete | Appears in breakout8c and later comparison reports | Safer/lower frequency but not validated and weak on expectancy/PF | Pause tuning unless specifically studying false-breakout reduction |
| trend_pullback_refined_v1 exists, is versioned, registered, and smoke-tested | complete | Appears in trend8d and later comparison reports | Strong quality pocket but over-filtered with too few trades | Plan v3 loosening experiment without touching router defaults |
| mean_reversion_refined_v1 exists, is versioned, registered, and smoke-tested | complete | Appears in mean8e and later comparison reports | Current v2 underperforms in held-out/refinement evidence | Rethink setup thesis before further tuning |
| Strategy Refinement Candidate Results exists | complete | No results8f/reporting-hardening section found | Earlier snapshots do not contain this section by design | Keep using latest report schema for future comparisons |
| Cross-report comparison exists | complete | This generated comparison report extracts the required cross-report sections | Source versioned reports may remain local artifacts | Keep comparison tooling and add machine-readable export |
| Base vs refined strategies are compared across assets, regimes, and walk-forward folds | complete | Comparison/results sections include multi-asset aggregate metrics, held-out candidate rows, and fold counts | Candidate metrics are directional and not pooled proof by themselves | Use pooled stats plus candidate rows together |
| Reporting separates hypothesis discovery from held-out/rolling validation | complete | Reports label in-sample discovery, held-out tests, rolling folds, and conservative verdicts | Markdown wording must stay disciplined as new experiments are added | Preserve discovery-vs-validation language in every future report |
| No strategy/router/candidate is incorrectly promoted as production-valid edge | needs review | Current conclusion states no validated edge and no router/default promotion | This is a report audit, not a production safety control | Keep promotion guardrails explicit until validation improves |

## Priority 8G Next Refinement Plan

### Momentum Continuation

- Best balanced improvement among the refined variants.
- Keep `momentum_continuation_refined_v1` as the main candidate for a future v3 investigation.
- Do not promote yet because rolling folds failed.

### Trend Pullback

- Strongest quality pocket, but likely over-filtered.
- Future v3 should test loosening gates carefully to increase trade count while preserving profit factor and drawdown behavior.

### Breakout Expansion

- Safer after refinement but still weak.
- Pause further tuning unless specifically studying false-breakout reduction.

### Mean Reversion

- Current v2 underperforms.
- Rethink setup logic before further tuning.
- Do not simply loosen gates without a new thesis.

## Promotion Guardrails

- Do not promote any refined strategy into router defaults unless it passes held-out and rolling-fold validation.
- Do not move to risk engine, paper trading, broker integration, order manager, or live execution based on current results.
- Treat current findings as research hypotheses only.
- Require more windows, more assets, and stronger fold consistency before production conclusions.

## Recommended Next Engineering Tasks

- Keep strict/missing-source warnings in `compareP5RefinementReports.ts`; this is already implemented via missing snapshot warnings, `COMPARE_P5_STRICT=1`, and optional `P5_COMPARE_REPORTS`.
- Keep report comparison tooling as part of the research workflow.
- Add optional CSV/JSON summary export from the comparison report so future analysis can be parsed without scraping Markdown.
- Add daily feature readiness before equity/ETF expansion.
- Add equity/ETF ingestion later for SPY, QQQ, AAPL, MSFT, and NVDA.
- Plan, but do not implement yet, Momentum v3 and Trend Pullback v3 experiments.

## Regime Interpretation Note

The regime label on each selected research window is the dominant-window regime used for sampling and aggregation. Refined strategy gates still evaluate bar-level regime context at the individual signal timestamp. A strategy can therefore be evaluated inside a TREND_UP-dominant window while its own gate accepts or rejects a specific bar using the latest persisted/proxy regime label for that bar.

## Non-Binding Gate Diagnostics Summary

Source report: `P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md`. These diagnostics are non-binding research checks; they summarize gate availability and selectivity but do not change strategy behavior or verdicts.

### Gates With 0 Fails

- breakout_expansion_refined_v1 / avoid_low_confidence_regime: passes=1811, fails=0, unavailablePasses=0, failRate=0.00%
- mean_reversion_refined_v1 / avoid_low_confidence_regime: passes=2623, fails=0, unavailablePasses=0, failRate=0.00%
- mean_reversion_refined_v1 / range_bound_context: passes=2623, fails=0, unavailablePasses=0, failRate=0.00%
- momentum_continuation_refined_v1 / avoid_low_confidence_regime: passes=7204, fails=0, unavailablePasses=0, failRate=0.00%
- momentum_continuation_refined_v1 / price_above_medium_trend: passes=7204, fails=0, unavailablePasses=0, failRate=0.00%
- trend_pullback_refined_v1 / avoid_low_confidence_regime: passes=5042, fails=0, unavailablePasses=0, failRate=0.00%

### Gates With >90% Fail Rate

- none

### Gates With Unavailable Passes

- none

## Strategy Refinement Candidate Comparison Extracts

### current-latest

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |-0.00 |+0.48 |-0.33 |0.00 |0.69 |1.80 |+1.11 |1.35 |0.59 |-12.1843 |12.2711 |+24.4553 |-6.4903 |11.3964 |6.06 |2.32 |-3.74 |1185 |48 |1137 (95.95%) |798 |30 |768 (96.24%) |741 |28 |713 (96.22%) |36.87 |1.57 |0.40 |0.39 |0/30 |0/15 |6/30 |0/15 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.08 |+0.23 |-0.07 |0.00 |0.68 |0.58 |-0.11 |0.69 |0.25 |-12.2865 |-17.6582 |-5.3716 |-0.4311 |-13.3771 |4.54 |2.99 |-1.55 |740 |118 |622 (84.05%) |509 |88 |421 (82.71%) |472 |76 |396 (83.90%) |16.28 |2.53 |1.27 |0.09 |0/30 |0/21 |2/30 |2/21 |

### Momentum Refined Test-Pass Breakdown

momentum_continuation_refined_v1 remains **NOT VALIDATED**. These rows passed the held-out 70/30 test gates but did not pass the full rolling-validation requirement, so none are promoted to validated edge or router defaults.

| asset |regime |train return |test return |test global PF |test expectancy |test trades |folds validated |final verdict |failure reason |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |TREND_UP |0.23 |0.87 |2.79 |28.9016 |6 |0/3 |NOT VALIDATED |rolling validation failed (0/3) |
| ETH-USD |TREND_UP |0.38 |0.62 |1.66 |18.7112 |10 |1/3 |NOT VALIDATED |rolling validation failed (1/3) |
| ETH-USD |LOW_VOL |-0.03 |0.30 |1.80 |18.6456 |8 |0/3 |NOT VALIDATED |rolling validation failed (0/3) |

### Gate Availability Diagnostics

Diagnostics evaluate each configured gate independently across base-strategy signal contexts that pass the refined variant's regime and reliability filters. `unavailable passes` are pass-open cases where a gate reason includes unavailable source data; they are useful for spotting indicators that are not actually constraining a variant.

| strategy |gate |passes |fails |unavailable passes |unavailable pass % |
| --- |--- |--- |--- |--- |--- |
| breakout_expansion_refined_v1 |avoid_low_confidence_regime |1811 |0 |0 |0.00% |
| breakout_expansion_refined_v1 |avoid_overextended_entry |1139 |672 |0 |0.00% |
| breakout_expansion_refined_v1 |macro_trend_confirmed |792 |1019 |0 |0.00% |
| breakout_expansion_refined_v1 |price_near_or_above_breakout_structure |1614 |197 |0 |0.00% |
| breakout_expansion_refined_v1 |trend_confirmed |1736 |75 |0 |0.00% |
| breakout_expansion_refined_v1 |volatility_expansion_confirmed |1767 |44 |0 |0.00% |
| breakout_expansion_refined_v1 |volume_confirmed |1614 |197 |0 |0.00% |
| mean_reversion_refined_v1 |avoid_low_confidence_regime |2623 |0 |0 |0.00% |
| mean_reversion_refined_v1 |oversold_confirmed |1086 |1537 |0 |0.00% |
| mean_reversion_refined_v1 |price_stretched_from_mean |934 |1689 |0 |0.00% |
| mean_reversion_refined_v1 |range_bound_context |2623 |0 |0 |0.00% |
| mean_reversion_refined_v1 |reversion_target_available |1647 |976 |0 |0.00% |
| mean_reversion_refined_v1 |volatility_not_expanding_aggressively_against_trade |2314 |309 |0 |0.00% |
| momentum_continuation_refined_v1 |avoid_low_confidence_regime |7204 |0 |0 |0.00% |
| momentum_continuation_refined_v1 |avoid_overextended_entry |6320 |884 |0 |0.00% |
| momentum_continuation_refined_v1 |macro_not_strongly_bearish |6312 |892 |0 |0.00% |
| momentum_continuation_refined_v1 |momentum_not_fading |6400 |804 |0 |0.00% |
| momentum_continuation_refined_v1 |price_above_medium_trend |7204 |0 |0 |0.00% |
| momentum_continuation_refined_v1 |short_term_momentum_confirmed |6571 |633 |0 |0.00% |
| momentum_continuation_refined_v1 |volume_not_dead |4689 |2515 |0 |0.00% |
| trend_pullback_refined_v1 |avoid_low_confidence_regime |5042 |0 |0 |0.00% |
| trend_pullback_refined_v1 |avoid_overextended_entry |4704 |338 |0 |0.00% |
| trend_pullback_refined_v1 |momentum_reset_without_reversal |2490 |2552 |0 |0.00% |
| trend_pullback_refined_v1 |pullback_into_support_zone |3641 |1401 |0 |0.00% |
| trend_pullback_refined_v1 |strong_macro_trend_confirmed |1808 |3234 |0 |0.00% |
| trend_pullback_refined_v1 |trend_not_broken |2585 |2457 |0 |0.00% |
| trend_pullback_refined_v1 |volume_not_weak |2366 |2676 |0 |0.00% |

### baseline

_Section not present in this report._

### breakout8c

_Section not present in this report._

### trend8d

_Section not present in this report._

### mean8e

_Section not present in this report._

### results8f

_Section not present in this report._

### reporting-hardening

_Section not present in this report._

## Strategy Refinement Candidate Results Extracts

### current-latest

This section uses held-out 70/30 test-window candidate metrics for base-vs-refined comparison, plus rolling expanding-window fold checks. Candidate metrics are averaged across held-out asset/regime candidate rows, so they are directional research evidence, not pooled trade-level proof. Pooled held-out trade stats are included separately where trades exist. Verdicts are conservative: a variant is VALIDATED only when held-out return, profit factor, expectancy, drawdown, trade sufficiency, and all comparable rolling-fold checks beat the base strategy. These are research verdicts only.

| strategy |variant |allowed regimes |blocked regimes |base avg return |refined avg return |base global PF |refined global PF |base global expectancy |refined global expectancy |base max drawdown |refined max drawdown |base trades |refined trades |trade reduction count |trade reduction % |base exposure |refined exposure |base gross profit |refined gross profit |base gross loss |refined gross loss |base pooled PF |refined pooled PF |base pooled expectancy |refined pooled expectancy |base pooled trades |refined pooled trades |comparable folds |missing base folds |missing refined folds |validated folds |verdict |warnings |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |TREND_UP, LOW_VOL, TREND_DOWN |CHOP, NEWS_SHOCK |-0.09 |0.06 |1.47 |0.83 |-8.6130 |-3.1294 |2.43 |1.90 |198 |79 |119 |60.10% |45.88 |14.94 |5082.63 |2513.22 |6622.87 |2402.85 |0.77 |1.05 |-7.7790 |1.3972 |198 |79 |80 |10 |10 |2 |NEEDS MORE DATA |none |
| trend_pullback |trend_pullback_refined_v1 |TREND_UP, HIGH_VOL |TREND_DOWN, CHOP, LOW_VOL, NEWS_SHOCK |-0.67 |0.03 |0.76 |3.24 |-15.7803 |69.5332 |5.41 |0.87 |329 |4 |325 |98.78% |36.87 |1.57 |8052.18 |281.08 |13498.74 |56.99 |0.60 |4.93 |-16.5549 |56.0228 |329 |4 |80 |10 |10 |0 |NEEDS MORE DATA |refined test trades 4 < 5; trade reduction > 90% |
| breakout_expansion |breakout_expansion_refined_v1 |TREND_UP, HIGH_VOL |LOW_VOL, TREND_DOWN, CHOP, NEWS_SHOCK |-0.54 |-0.02 |0.68 |0.64 |-17.9377 |-22.1907 |4.41 |1.24 |308 |7 |301 |97.73% |34.01 |4.61 |6721.08 |182.98 |11946.33 |254.39 |0.56 |0.72 |-16.9651 |-10.2013 |308 |7 |80 |10 |10 |0 |NOT VALIDATED |trade reduction > 90% |
| mean_reversion_bounce |mean_reversion_refined_v1 |LOW_VOL, CHOP |TREND_DOWN, TREND_UP, HIGH_VOL, NEWS_SHOCK |-0.33 |-0.08 |0.61 |0.47 |-2.5079 |-14.8434 |3.89 |1.77 |228 |36 |192 |84.21% |16.28 |2.53 |6162.57 |829.63 |8544.05 |1366.57 |0.72 |0.61 |-10.4451 |-14.9150 |228 |36 |80 |10 |10 |1 |NEEDS MORE DATA |none |

### baseline

_Section not present in this report._

### breakout8c

_Section not present in this report._

### trend8d

_Section not present in this report._

### mean8e

_Section not present in this report._

### results8f

_Section not present in this report._

### reporting-hardening

_Section not present in this report._

## Cross-Asset Validated Candidate Summary Extracts

### current-latest

This summary is intentionally conservative. VALIDATED means the candidate passed the held-out 70/30 test and every rolling expanding-window fold. NEEDS MORE DATA means some out-of-sample evidence exists but the full strict standard was not met.

| asset |regime |strategy |test return |test global PF |test expectancy |test max drawdown |test trades |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| ETH-USD |TREND_UP |momentum_continuation |0.77 |2.59 |28.8735 |0.90 |8 |2/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |trend_pullback_refined_v1 |0.64 |3.24 |42.5125 |0.87 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |momentum_continuation_refined_v1 |0.62 |1.66 |18.7112 |1.47 |10 |1/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback |0.53 |1.84 |22.6447 |1.18 |7 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation_refined_v1 |0.40 |1.75 |20.1638 |0.60 |2 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation |0.38 |1.70 |18.8763 |0.88 |2 |1/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |momentum_continuation |0.35 |2.31 |23.5291 |0.96 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |mean_reversion_bounce |0.27 |1.86 |16.4479 |0.59 |5 |0/3 |NEEDS MORE DATA |
| LINK-USD |LOW_VOL |mean_reversion_refined_v1 |0.02 |1.10 |2.9297 |1.25 |5 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |breakout_expansion_refined_v1 |0.01 |1.03 |0.7820 |0.89 |3 |0/3 |NEEDS MORE DATA |
| AVAX-USD |CHOP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |mean_reversion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |CHOP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |TREND_DOWN |mean_reversion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |LOW_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_bounce |-0.04 |0.91 |-2.6357 |1.71 |10 |1/3 |NEEDS MORE DATA |
| SOL-USD |LOW_VOL |mean_reversion_refined_v1 |-0.09 |0.60 |-15.2981 |1.30 |4 |0/3 |NEEDS MORE DATA |
| AVAX-USD |HIGH_VOL |momentum_continuation |-0.52 |0.00 |-51.6257 |0.99 |1 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |breakout_expansion |-2.01 |0.31 |-33.5512 |2.91 |6 |1/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation |n/a |n/a |n/a |n/a |0 |2/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |trend_pullback_refined_v1 |n/a |n/a |n/a |n/a |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |NEWS_SHOCK |momentum_continuation |-0.02 |0.95 |-1.4965 |1.48 |7 |0/3 |NOT VALIDATED |
| AVAX-USD |LOW_VOL |mean_reversion_refined_v1 |-0.19 |0.34 |-31.0907 |0.86 |5 |0/3 |NOT VALIDATED |
| AVAX-USD |LOW_VOL |mean_reversion_bounce |-0.99 |0.42 |-26.4528 |3.07 |30 |0/3 |NOT VALIDATED |

### baseline

_Section not present in this report._

### breakout8c

_Section not present in this report._

### trend8d

_Section not present in this report._

### mean8e

_Section not present in this report._

### results8f

_Section not present in this report._

### reporting-hardening

_Section not present in this report._

## Cross-Asset Router Validation Summary Extracts

### current-latest

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |momentum_continuation_refined_v1 (0.02%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |trend_pullback_refined_v1 (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |momentum_continuation (1.16) |conservative_router |0.33 |1.69 |16.4612 |VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.69) |top_by_regime_return_router |-0.13 |0.70 |-9.7969 |NOT VALIDATED |0/3 |NOT VALIDATED |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (-0.00%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### baseline

_Section not present in this report._

### breakout8c

_Section not present in this report._

### trend8d

_Section not present in this report._

### mean8e

_Section not present in this report._

### results8f

_Section not present in this report._

### reporting-hardening

_Section not present in this report._
