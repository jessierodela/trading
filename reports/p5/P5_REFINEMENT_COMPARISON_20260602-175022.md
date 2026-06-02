# P5 Refinement Cross-Report Comparison Summary

Generated: 2026-06-02T22:50:22.613Z

Note: source versioned P5 reports are local research artifacts and may not be committed to git. This comparison stores the extracted sections needed for review.

## Compared Reports

| label | report | Strategy Refinement Candidate Comparison | Strategy Refinement Candidate Results | Cross-Asset Validated Candidate Summary | Cross-Asset Router Validation Summary | Gate Availability Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
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
| Cross-Asset Opportunity Walk-Forward Validation exists | missing | No matching section found | Candidate-level validation is still directional and sample-limited | Keep using held-out plus rolling folds before treating opportunities as edge |
| Reusable strategy refinement / gating framework exists | needs review | Refined variants, gate diagnostics, and base-vs-refined report sections are present | Gate diagnostics are report-level observability, not a replacement for causal strategy research | Keep framework stable while planning v3 experiments |
| momentum_continuation_refined_v1 exists, is versioned, registered, and smoke-tested | missing | Appears in refinement comparison/results, strategy versions, and momentum test-pass breakdown | Improved quality metrics but failed rolling folds | Keep as main v3 investigation candidate; do not promote |
| breakout_expansion_refined_v1 exists, is versioned, registered, and smoke-tested | missing | Appears in breakout8c and later comparison reports | Safer/lower frequency but not validated and weak on expectancy/PF | Pause tuning unless specifically studying false-breakout reduction |
| trend_pullback_refined_v1 exists, is versioned, registered, and smoke-tested | missing | Appears in trend8d and later comparison reports | Strong quality pocket but over-filtered with too few trades | Plan v3 loosening experiment without touching router defaults |
| mean_reversion_refined_v1 exists, is versioned, registered, and smoke-tested | missing | Appears in mean8e and later comparison reports | Current v2 underperforms in held-out/refinement evidence | Rethink setup thesis before further tuning |
| Strategy Refinement Candidate Results exists | missing | No results8f/reporting-hardening section found | Earlier snapshots do not contain this section by design | Keep using latest report schema for future comparisons |
| Cross-report comparison exists | complete | This generated comparison report extracts the required cross-report sections | Source versioned reports may remain local artifacts | Keep comparison tooling and add machine-readable export |
| Base vs refined strategies are compared across assets, regimes, and walk-forward folds | partial | Comparison/results sections include multi-asset aggregate metrics, held-out candidate rows, and fold counts | Candidate metrics are directional and not pooled proof by themselves | Use pooled stats plus candidate rows together |
| Reporting separates hypothesis discovery from held-out/rolling validation | needs review | Reports label in-sample discovery, held-out tests, rolling folds, and conservative verdicts | Markdown wording must stay disciplined as new experiments are added | Preserve discovery-vs-validation language in every future report |
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

No Gate Availability Diagnostics table was found in the selected reports.

## Strategy Refinement Candidate Comparison Extracts

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
