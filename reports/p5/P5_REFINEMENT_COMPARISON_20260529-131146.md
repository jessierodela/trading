# P5 Refinement Cross-Report Comparison Summary

Generated: 2026-05-29T18:11:46.927Z

## Compared Reports

| label | report | Strategy Refinement Candidate Comparison | Strategy Refinement Candidate Results | Cross-Asset Validated Candidate Summary | Cross-Asset Router Validation Summary | Gate Availability Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_20260529-095405.md | yes | no | yes | yes | no |
| breakout8c | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_breakout8c-20260529-102329.md | yes | no | yes | yes | no |
| trend8d | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_trend8d-20260529-110127.md | yes | no | yes | yes | no |
| mean8e | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_mean8e-20260529-110833.md | yes | no | yes | yes | no |
| results8f | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_results8f-20260529-111415.md | yes | yes | yes | yes | no |
| reporting-hardening | reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_reporting-hardening-20260529-114100.md | yes | yes | yes | yes | yes |

## Current Conclusion

- No refined strategy candidate should be treated as validated edge from the current report set.
- `momentum_continuation_refined_v1` improved quality metrics but failed rolling-fold validation.
- `trend_pullback_refined_v1` appears over-filtered and needs either looser research gates or more qualifying samples before any edge claim.
- `breakout_expansion_refined_v1` remains not validated.
- `mean_reversion_refined_v1` underperforms in the current held-out/refinement evidence.

## Regime Interpretation Note

The regime label on each selected research window is the dominant-window regime used for sampling and aggregation. Refined strategy gates still evaluate bar-level regime context at the individual signal timestamp. A strategy can therefore be evaluated inside a TREND_UP-dominant window while its own gate accepts or rejects a specific bar using the latest persisted/proxy regime label for that bar.

## Non-Binding Gate Diagnostics Summary

Source report: `reports\p5\P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_reporting-hardening-20260529-114100.md`. These diagnostics are non-binding research checks; they summarize gate availability and selectivity but do not change strategy behavior or verdicts.

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

### baseline

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.15 |+0.17 |-0.27 |0.00 |0.72 |0.71 |-0.00 |0.89 |0.65 |-10.1461 |-10.7616 |-0.6155 |-9.4088 |-14.9815 |4.41 |3.61 |-0.79 |944 |405 |539 (57.10%) |34.01 |11.33 |0.05 |0.03 |0/30 |0/26 |3/30 |2/26 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |0.03 |+0.51 |-0.33 |0.00 |0.69 |1.29 |+0.61 |1.35 |1.05 |-12.1843 |7.3439 |+19.5282 |-6.4903 |5.2813 |6.06 |2.57 |-3.50 |1185 |110 |1075 (90.72%) |36.87 |6.03 |0.40 |1.19 |0/30 |0/23 |6/30 |1/23 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.16 |+0.15 |-0.07 |0.00 |0.68 |0.75 |+0.07 |0.69 |1.07 |-12.2865 |-9.5079 |+2.7786 |-0.4311 |-0.2551 |4.54 |3.50 |-1.05 |740 |489 |251 (33.92%) |16.28 |10.68 |1.27 |0.70 |0/30 |0/30 |2/30 |5/30 |

### breakout8c

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |0.03 |+0.51 |-0.33 |0.00 |0.69 |1.29 |+0.61 |1.35 |1.05 |-12.1843 |7.3439 |+19.5282 |-6.4903 |5.2813 |6.06 |2.57 |-3.50 |1185 |110 |1075 (90.72%) |798 |60 |738 (92.48%) |741 |52 |689 (92.98%) |36.87 |6.03 |0.40 |1.19 |0/30 |0/23 |6/30 |1/23 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.16 |+0.15 |-0.07 |0.00 |0.68 |0.75 |+0.07 |0.69 |1.07 |-12.2865 |-9.5079 |+2.7786 |-0.4311 |-0.2551 |4.54 |3.50 |-1.05 |740 |489 |251 (33.92%) |509 |329 |180 (35.36%) |472 |307 |165 (34.96%) |16.28 |10.68 |1.27 |0.70 |0/30 |0/30 |2/30 |5/30 |

### trend8d

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |-0.00 |+0.48 |-0.33 |0.00 |0.69 |1.80 |+1.11 |1.35 |0.59 |-12.1843 |12.2711 |+24.4553 |-6.4903 |11.3964 |6.06 |2.32 |-3.74 |1185 |48 |1137 (95.95%) |798 |30 |768 (96.24%) |741 |28 |713 (96.22%) |36.87 |1.57 |0.40 |0.39 |0/30 |0/15 |6/30 |0/15 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.16 |+0.15 |-0.07 |0.00 |0.68 |0.75 |+0.07 |0.69 |1.07 |-12.2865 |-9.5079 |+2.7786 |-0.4311 |-0.2551 |4.54 |3.50 |-1.05 |740 |489 |251 (33.92%) |509 |329 |180 (35.36%) |472 |307 |165 (34.96%) |16.28 |10.68 |1.27 |0.70 |0/30 |0/30 |2/30 |5/30 |

### mean8e

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |-0.00 |+0.48 |-0.33 |0.00 |0.69 |1.80 |+1.11 |1.35 |0.59 |-12.1843 |12.2711 |+24.4553 |-6.4903 |11.3964 |6.06 |2.32 |-3.74 |1185 |48 |1137 (95.95%) |798 |30 |768 (96.24%) |741 |28 |713 (96.22%) |36.87 |1.57 |0.40 |0.39 |0/30 |0/15 |6/30 |0/15 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.08 |+0.23 |-0.07 |0.00 |0.68 |0.58 |-0.11 |0.69 |0.25 |-12.2865 |-17.6582 |-5.3716 |-0.4311 |-13.3771 |4.54 |2.99 |-1.55 |740 |118 |622 (84.05%) |509 |88 |421 (82.71%) |472 |76 |396 (83.90%) |16.28 |2.53 |1.27 |0.09 |0/30 |0/21 |2/30 |2/21 |

### results8f

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |-0.00 |+0.48 |-0.33 |0.00 |0.69 |1.80 |+1.11 |1.35 |0.59 |-12.1843 |12.2711 |+24.4553 |-6.4903 |11.3964 |6.06 |2.32 |-3.74 |1185 |48 |1137 (95.95%) |798 |30 |768 (96.24%) |741 |28 |713 (96.22%) |36.87 |1.57 |0.40 |0.39 |0/30 |0/15 |6/30 |0/15 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.08 |+0.23 |-0.07 |0.00 |0.68 |0.58 |-0.11 |0.69 |0.25 |-12.2865 |-17.6582 |-5.3716 |-0.4311 |-13.3771 |4.54 |2.99 |-1.55 |740 |118 |622 (84.05%) |509 |88 |421 (82.71%) |472 |76 |396 (83.90%) |16.28 |2.53 |1.27 |0.09 |0/30 |0/21 |2/30 |2/21 |

### reporting-hardening

Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.

| base |refined |base ret% |refined ret% |ret delta |base medRet% |refined medRet% |base gPF |refined gPF |gPF delta |base avgPF |refined avgPF |base gExpect |refined gExpect |expect delta |base avgExpect |refined avgExpect |base maxDD |refined maxDD |DD delta |base trades |refined trades |trade reduction |base losses |refined losses |loss reduction |base stops |refined stops |stop reduction |base exposure |refined exposure |base ret/DD |refined ret/DD |base validated |refined validated |base test pass |refined test pass |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |-0.02 |0.00 |+0.02 |-0.09 |0.00 |0.98 |1.02 |+0.04 |1.50 |0.79 |-0.6712 |0.4861 |+1.1573 |-1.0573 |-5.4115 |3.14 |1.96 |-1.19 |620 |228 |392 (63.23%) |380 |135 |245 (64.47%) |307 |118 |189 (61.56%) |45.88 |14.94 |0.52 |0.24 |0/30 |0/22 |4/30 |3/22 |
| breakout_expansion |breakout_expansion_refined_v1 |-0.32 |-0.05 |+0.27 |-0.27 |0.00 |0.72 |0.69 |-0.03 |0.89 |0.74 |-10.1461 |-11.6407 |-1.4945 |-9.4088 |-17.5433 |4.41 |2.94 |-1.47 |944 |135 |809 (85.70%) |619 |94 |525 (84.81%) |560 |84 |476 (85.00%) |34.01 |4.61 |0.05 |0.05 |0/30 |0/20 |3/30 |0/20 |
| trend_pullback |trend_pullback_refined_v1 |-0.49 |-0.00 |+0.48 |-0.33 |0.00 |0.69 |1.80 |+1.11 |1.35 |0.59 |-12.1843 |12.2711 |+24.4553 |-6.4903 |11.3964 |6.06 |2.32 |-3.74 |1185 |48 |1137 (95.95%) |798 |30 |768 (96.24%) |741 |28 |713 (96.22%) |36.87 |1.57 |0.40 |0.39 |0/30 |0/15 |6/30 |0/15 |
| mean_reversion_bounce |mean_reversion_refined_v1 |-0.31 |-0.08 |+0.23 |-0.07 |0.00 |0.68 |0.58 |-0.11 |0.69 |0.25 |-12.2865 |-17.6582 |-5.3716 |-0.4311 |-13.3771 |4.54 |2.99 |-1.55 |740 |118 |622 (84.05%) |509 |88 |421 (82.71%) |472 |76 |396 (83.90%) |16.28 |2.53 |1.27 |0.09 |0/30 |0/21 |2/30 |2/21 |

## Strategy Refinement Candidate Results Extracts

### baseline

_Section not present in this report._

### breakout8c

_Section not present in this report._

### trend8d

_Section not present in this report._

### mean8e

_Section not present in this report._

### results8f

This section uses held-out 70/30 test-window candidate metrics for base-vs-refined comparison, plus rolling expanding-window fold checks. Verdicts are conservative: a variant is VALIDATED only when held-out return, profit factor, expectancy, drawdown, trade sufficiency, and all rolling-fold checks beat the base strategy. These are research verdicts only.

| strategy |variant |allowed regimes |blocked regimes |base avg return |refined avg return |base global PF |refined global PF |base global expectancy |refined global expectancy |base max drawdown |refined max drawdown |base trades |refined trades |trade reduction % |base exposure |refined exposure |folds validated |verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |TREND_UP, LOW_VOL, TREND_DOWN |CHOP, NEWS_SHOCK |-0.09 |0.06 |1.47 |0.83 |-8.6130 |-3.1294 |2.43 |1.90 |198 |79 |119 (60.10%) |45.88 |14.94 |2/90 |NEEDS MORE DATA |
| breakout_expansion |breakout_expansion_refined_v1 |TREND_UP, HIGH_VOL |LOW_VOL, TREND_DOWN, CHOP, NEWS_SHOCK |-0.54 |-0.02 |0.68 |0.64 |-17.9377 |-22.1907 |4.41 |1.24 |308 |7 |301 (97.73%) |34.01 |4.61 |0/90 |NOT VALIDATED |
| trend_pullback |trend_pullback_refined_v1 |TREND_UP, HIGH_VOL |TREND_DOWN, CHOP, LOW_VOL, NEWS_SHOCK |-0.67 |0.03 |0.76 |3.24 |-15.7803 |69.5332 |5.41 |0.87 |329 |4 |325 (98.78%) |36.87 |1.57 |0/90 |NEEDS MORE DATA |
| mean_reversion_bounce |mean_reversion_refined_v1 |LOW_VOL, CHOP |TREND_DOWN, TREND_UP, HIGH_VOL, NEWS_SHOCK |-0.33 |-0.08 |0.61 |0.47 |-2.5079 |-14.8434 |3.89 |1.77 |228 |36 |192 (84.21%) |16.28 |2.53 |1/90 |NEEDS MORE DATA |

### reporting-hardening

This section uses held-out 70/30 test-window candidate metrics for base-vs-refined comparison, plus rolling expanding-window fold checks. Candidate metrics are averaged across held-out asset/regime candidate rows, so they are directional research evidence, not pooled trade-level proof. Pooled held-out trade stats are included separately where trades exist. Verdicts are conservative: a variant is VALIDATED only when held-out return, profit factor, expectancy, drawdown, trade sufficiency, and all comparable rolling-fold checks beat the base strategy. These are research verdicts only.

| strategy |variant |allowed regimes |blocked regimes |base avg return |refined avg return |base global PF |refined global PF |base global expectancy |refined global expectancy |base max drawdown |refined max drawdown |base trades |refined trades |trade reduction count |trade reduction % |base exposure |refined exposure |base gross profit |refined gross profit |base gross loss |refined gross loss |base pooled PF |refined pooled PF |base pooled expectancy |refined pooled expectancy |base pooled trades |refined pooled trades |comparable folds |missing base folds |missing refined folds |validated folds |verdict |warnings |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| momentum_continuation |momentum_continuation_refined_v1 |TREND_UP, LOW_VOL, TREND_DOWN |CHOP, NEWS_SHOCK |-0.09 |0.06 |1.47 |0.83 |-8.6130 |-3.1294 |2.43 |1.90 |198 |79 |119 |60.10% |45.88 |14.94 |5082.63 |2513.22 |6622.87 |2402.85 |0.77 |1.05 |-7.7790 |1.3972 |198 |79 |80 |10 |10 |2 |NEEDS MORE DATA |none |
| trend_pullback |trend_pullback_refined_v1 |TREND_UP, HIGH_VOL |TREND_DOWN, CHOP, LOW_VOL, NEWS_SHOCK |-0.67 |0.03 |0.76 |3.24 |-15.7803 |69.5332 |5.41 |0.87 |329 |4 |325 |98.78% |36.87 |1.57 |8052.18 |281.08 |13498.74 |56.99 |0.60 |4.93 |-16.5549 |56.0228 |329 |4 |80 |10 |10 |0 |NEEDS MORE DATA |refined test trades 4 < 5; trade reduction > 90% |
| breakout_expansion |breakout_expansion_refined_v1 |TREND_UP, HIGH_VOL |LOW_VOL, TREND_DOWN, CHOP, NEWS_SHOCK |-0.54 |-0.02 |0.68 |0.64 |-17.9377 |-22.1907 |4.41 |1.24 |308 |7 |301 |97.73% |34.01 |4.61 |6721.08 |182.98 |11946.33 |254.39 |0.56 |0.72 |-16.9651 |-10.2013 |308 |7 |80 |10 |10 |0 |NOT VALIDATED |trade reduction > 90% |
| mean_reversion_bounce |mean_reversion_refined_v1 |LOW_VOL, CHOP |TREND_DOWN, TREND_UP, HIGH_VOL, NEWS_SHOCK |-0.33 |-0.08 |0.61 |0.47 |-2.5079 |-14.8434 |3.89 |1.77 |228 |36 |192 |84.21% |16.28 |2.53 |6162.57 |829.63 |8544.05 |1366.57 |0.72 |0.61 |-10.4451 |-14.9150 |228 |36 |80 |10 |10 |1 |NEEDS MORE DATA |none |

## Cross-Asset Validated Candidate Summary Extracts

### baseline

This summary is intentionally conservative. VALIDATED means the candidate passed the held-out 70/30 test and every rolling expanding-window fold. NEEDS MORE DATA means some out-of-sample evidence exists but the full strict standard was not met.

| asset |regime |strategy |test return |test global PF |test expectancy |test max drawdown |test trades |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| ETH-USD |TREND_UP |momentum_continuation |0.77 |2.59 |28.8735 |0.90 |8 |2/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |momentum_continuation_refined_v1 |0.62 |1.66 |18.7112 |1.47 |10 |1/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback |0.53 |1.84 |22.6447 |1.18 |7 |0/3 |NEEDS MORE DATA |
| AVAX-USD |CHOP |breakout_expansion_refined_v1 |0.47 |n/a |94.5083 |0.93 |1 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation_refined_v1 |0.40 |1.75 |20.1638 |0.60 |2 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation |0.38 |1.70 |18.8763 |0.88 |2 |1/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |momentum_continuation |0.35 |2.31 |23.5291 |0.96 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback_refined_v1 |0.32 |n/a |95.3068 |0.49 |1 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |trend_pullback_refined_v1 |0.29 |1.44 |11.6025 |1.37 |5 |1/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |mean_reversion_bounce |0.27 |1.86 |16.4479 |0.59 |5 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_refined_v1 |0.19 |1.66 |16.1520 |1.71 |7 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_DOWN |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |TREND_DOWN |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |1/3 |NEEDS MORE DATA |
| AVAX-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |CHOP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |NEWS_SHOCK |breakout_expansion_refined_v1 |-0.03 |0.95 |-1.5260 |0.83 |6 |1/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_bounce |-0.04 |0.91 |-2.6357 |1.71 |10 |1/3 |NEEDS MORE DATA |
| AVAX-USD |HIGH_VOL |momentum_continuation |-0.52 |0.00 |-51.6257 |0.99 |1 |0/3 |NEEDS MORE DATA |
| AVAX-USD |NEWS_SHOCK |mean_reversion_refined_v1 |-0.60 |0.00 |-59.5675 |0.60 |1 |0/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation |n/a |n/a |n/a |n/a |0 |2/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |trend_pullback_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| BTC-USD |NEWS_SHOCK |momentum_continuation |-0.02 |0.95 |-1.4965 |1.48 |7 |0/3 |NOT VALIDATED |
| LINK-USD |TREND_UP |breakout_expansion |-2.01 |0.31 |-33.5512 |2.91 |6 |0/3 |NOT VALIDATED |

### breakout8c

This summary is intentionally conservative. VALIDATED means the candidate passed the held-out 70/30 test and every rolling expanding-window fold. NEEDS MORE DATA means some out-of-sample evidence exists but the full strict standard was not met.

| asset |regime |strategy |test return |test global PF |test expectancy |test max drawdown |test trades |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| ETH-USD |TREND_UP |momentum_continuation |0.77 |2.59 |28.8735 |0.90 |8 |2/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |momentum_continuation_refined_v1 |0.62 |1.66 |18.7112 |1.47 |10 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation_refined_v1 |0.40 |1.75 |20.1638 |0.60 |2 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation |0.38 |1.70 |18.8763 |0.88 |2 |1/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |momentum_continuation |0.35 |2.31 |23.5291 |0.96 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback_refined_v1 |0.32 |n/a |95.3068 |0.49 |1 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |trend_pullback_refined_v1 |0.29 |1.44 |11.6025 |1.37 |5 |1/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |mean_reversion_bounce |0.27 |1.86 |16.4479 |0.59 |5 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_refined_v1 |0.19 |1.66 |16.1520 |1.71 |7 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |breakout_expansion_refined_v1 |0.01 |1.03 |0.7820 |0.89 |3 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| AVAX-USD |CHOP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_DOWN |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |TREND_DOWN |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |1/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| AVAX-USD |HIGH_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |CHOP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_bounce |-0.04 |0.91 |-2.6357 |1.71 |10 |1/3 |NEEDS MORE DATA |
| AVAX-USD |NEWS_SHOCK |mean_reversion_refined_v1 |-0.60 |0.00 |-59.5675 |0.60 |1 |0/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation |n/a |n/a |n/a |n/a |0 |2/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |trend_pullback_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| BTC-USD |NEWS_SHOCK |momentum_continuation |-0.02 |0.95 |-1.4965 |1.48 |7 |0/3 |NOT VALIDATED |
| LINK-USD |TREND_UP |breakout_expansion |-2.01 |0.31 |-33.5512 |2.91 |6 |0/3 |NOT VALIDATED |

### trend8d

This summary is intentionally conservative. VALIDATED means the candidate passed the held-out 70/30 test and every rolling expanding-window fold. NEEDS MORE DATA means some out-of-sample evidence exists but the full strict standard was not met.

| asset |regime |strategy |test return |test global PF |test expectancy |test max drawdown |test trades |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |TREND_UP |momentum_continuation |0.93 |3.31 |31.1471 |1.27 |6 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |momentum_continuation |0.77 |2.59 |28.8735 |0.90 |8 |2/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |trend_pullback_refined_v1 |0.64 |3.24 |42.5125 |0.87 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |momentum_continuation_refined_v1 |0.62 |1.66 |18.7112 |1.47 |10 |1/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback |0.53 |1.84 |22.6447 |1.18 |7 |1/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation_refined_v1 |0.40 |1.75 |20.1638 |0.60 |2 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |momentum_continuation |0.38 |1.70 |18.8763 |0.88 |2 |1/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |momentum_continuation |0.35 |2.31 |23.5291 |0.96 |3 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |mean_reversion_bounce |0.27 |1.86 |16.4479 |0.59 |5 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_refined_v1 |0.19 |1.66 |16.1520 |1.71 |7 |0/3 |NEEDS MORE DATA |
| AVAX-USD |TREND_UP |breakout_expansion_refined_v1 |0.01 |1.03 |0.7820 |0.89 |3 |0/3 |NEEDS MORE DATA |
| AVAX-USD |CHOP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |CHOP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |LOW_VOL |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |TREND_UP |trend_pullback_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| ETH-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |HIGH_VOL |momentum_continuation_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| LINK-USD |TREND_UP |breakout_expansion_refined_v1 |0.00 |n/a |n/a |0.00 |0 |0/3 |NEEDS MORE DATA |
| SOL-USD |NEWS_SHOCK |mean_reversion_bounce |-0.04 |0.91 |-2.6357 |1.71 |10 |1/3 |NEEDS MORE DATA |
| AVAX-USD |HIGH_VOL |momentum_continuation |-0.52 |0.00 |-51.6257 |0.99 |1 |0/3 |NEEDS MORE DATA |
| AVAX-USD |NEWS_SHOCK |mean_reversion_refined_v1 |-0.60 |0.00 |-59.5675 |0.60 |1 |0/3 |NEEDS MORE DATA |
| AVAX-USD |NEWS_SHOCK |mean_reversion_bounce |-1.77 |0.00 |-58.9977 |1.77 |3 |0/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation |n/a |n/a |n/a |n/a |0 |2/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |momentum_continuation_refined_v1 |n/a |n/a |n/a |n/a |0 |1/3 |NEEDS MORE DATA |
| SOL-USD |TREND_UP |trend_pullback_refined_v1 |n/a |n/a |n/a |n/a |0 |0/3 |NEEDS MORE DATA |
| BTC-USD |NEWS_SHOCK |momentum_continuation |-0.02 |0.95 |-1.4965 |1.48 |7 |0/3 |NOT VALIDATED |
| AVAX-USD |LOW_VOL |mean_reversion_refined_v1 |-0.29 |0.71 |-11.0798 |3.07 |21 |0/3 |NOT VALIDATED |
| AVAX-USD |LOW_VOL |mean_reversion_bounce |-0.99 |0.42 |-26.4528 |3.07 |30 |0/3 |NOT VALIDATED |
| LINK-USD |TREND_UP |breakout_expansion |-2.01 |0.31 |-33.5512 |2.91 |6 |0/3 |NOT VALIDATED |

### mean8e

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

### results8f

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

### reporting-hardening

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

## Cross-Asset Router Validation Summary Extracts

### baseline

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |trend_pullback_refined_v1 (0.03%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |momentum_continuation (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |trend_pullback_refined_v1 (3.30) |conservative_router |0.33 |1.69 |16.4612 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.91) |top_by_regime_retdd_router |0.11 |1.42 |12.7475 |VALIDATED |0/3 |NEEDS MORE DATA |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (0.08%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### breakout8c

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |trend_pullback_refined_v1 (0.03%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |momentum_continuation (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |trend_pullback_refined_v1 (3.30) |conservative_router |0.33 |1.69 |16.4612 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.91) |top_by_regime_retdd_router |0.11 |1.42 |12.7475 |VALIDATED |0/3 |NEEDS MORE DATA |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (0.08%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### trend8d

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |momentum_continuation_refined_v1 (0.02%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |trend_pullback_refined_v1 (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |momentum_continuation (1.16) |conservative_router |0.33 |1.69 |16.4612 |VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.69) |conservative_router |-0.05 |0.90 |-3.0767 |NOT VALIDATED |0/3 |NOT VALIDATED |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (-0.00%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### mean8e

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |momentum_continuation_refined_v1 (0.02%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |trend_pullback_refined_v1 (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |momentum_continuation (1.16) |conservative_router |0.33 |1.69 |16.4612 |VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.69) |top_by_regime_return_router |-0.13 |0.70 |-9.7969 |NOT VALIDATED |0/3 |NOT VALIDATED |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (-0.00%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### results8f

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |momentum_continuation_refined_v1 (0.02%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |trend_pullback_refined_v1 (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |momentum_continuation (1.16) |conservative_router |0.33 |1.69 |16.4612 |VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.69) |top_by_regime_return_router |-0.13 |0.70 |-9.7969 |NOT VALIDATED |0/3 |NOT VALIDATED |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (-0.00%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |

### reporting-hardening

One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.

| asset |windows |med purity% |best static (ret) |best static (ret/DD) |best router |router test ret% |router test gPF |router test gExpect |test verdict |folds validated |final verdict |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| BTC-USD |60 |69.44 |momentum_continuation_refined_v1 (0.02%) |mean_reversion_bounce (2.60) |conservative_router |0.10 |1.50 |11.2949 |NOT VALIDATED |0/3 |NOT VALIDATED |
| AVAX-USD |60 |70.49 |trend_pullback_refined_v1 (0.04%) |mean_reversion_bounce (1.06) |conservative_router |0.03 |1.36 |7.5241 |NOT VALIDATED |1/3 |NEEDS MORE DATA |
| ETH-USD |60 |70.49 |momentum_continuation (0.10%) |momentum_continuation (1.16) |conservative_router |0.33 |1.69 |16.4612 |VALIDATED |1/3 |NEEDS MORE DATA |
| LINK-USD |60 |72.57 |momentum_continuation_refined_v1 (0.04%) |trend_pullback_refined_v1 (0.69) |top_by_regime_return_router |-0.13 |0.70 |-9.7969 |NOT VALIDATED |0/3 |NOT VALIDATED |
| SOL-USD |60 |72.92 |trend_pullback_refined_v1 (-0.00%) |mean_reversion_bounce (1.52) |conservative_router |-0.15 |0.27 |-30.5052 |NOT VALIDATED |0/3 |NOT VALIDATED |
