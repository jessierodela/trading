/**
 * lib/versions.ts
 *
 * Single source of truth for code/prompt/model version stamps that get
 * persisted on every row.
 *
 * Why these exist: every persisted row carries lineage so we can answer
 * "what code produced this?" months later. Comparing strategy A v1 to v2
 * is only meaningful if we know which version generated which row.
 *
 * Discipline:
 *   - When the logic in a feature engine, strategy, regime detector, prompt,
 *     or risk rule changes meaningfully, bump the version here and add a
 *     CHANGELOG line.
 *   - "Meaningfully" means: would two backtest runs produce different
 *     results? If yes, bump. If no (e.g. rename, comment change, log
 *     wording), don't bump.
 *   - Never reuse a version string. v2 stays v2 forever, even after
 *     superseded.
 *   - Never rewrite old rows. A row tagged with v1 keeps v1 even after the
 *     module is at v3.
 *   - This is enforced socially via code review, not automatically. Cost of
 *     forgetting is that v1 rows silently contain v2 logic — which is the
 *     worst possible failure mode for backtest analysis. Catch it in review.
 *
 * Naming convention:
 *   "<scope>.<year-month-day>.v<n>"  for major bumps (date + sequence)
 *   "<scope>.v<n>"                    is also acceptable for stable modules
 *
 * Examples that ARE meaningful and require a bump:
 *   - Strategy threshold change (e.g. RSI <30 → RSI <25)
 *   - Feature engine adds a new field or changes the formula for an existing one
 *   - Regime detector prompt text changes
 *   - Risk rule numbers change (max risk per trade, daily loss cap)
 *
 * Examples that do NOT require a bump:
 *   - Bug fix that restores intended behavior (still note in CHANGELOG)
 *   - Renaming a private variable
 *   - Adjusting log lines
 *   - Adding test coverage
 */

// ─── Feature engine ────────────────────────────────────────────────────────
/**
 * CHANGELOG:
 *   features.2026-05-13.v1  - Initial stub. Never used in production —
 *                              superseded by .v2 before any rows persisted.
 *   features.2026-05-16.v2  - P2C: real engine ships. rsi14, macd-family,
 *                              ema20/50/200, atr14, bb20, volumeSma20,
 *                              relativeVolume20, derived distance and
 *                              range fields. Wilder smoothing for RSI/ATR;
 *                              standard EMA alpha for EMAs; population
 *                              stdev for BB. Gap-aware: two public entries
 *                              (Latest, Segmented), warmup never crosses
 *                              gaps. DO NOT USE: RSI flat-series bug
 *                              (returns 100 instead of 50); superseded by
 *                              v3 before production rows were persisted.
 *   features.2026-05-20.v3  - Fix RSI flat-series: avgGain=0 && avgLoss=0
 *                              now returns 50 (neutral) instead of 100
 *                              (overbought). All other math unchanged.
 *                              Version bump required because ON CONFLICT DO
 *                              NOTHING means v2 rows cannot be corrected
 *                              in-place; v3 rows carry the correct value.
 */
export const FEATURE_VERSION = "features.2026-05-20.v3";

// ─── Strategy versions ─────────────────────────────────────────────────────
// One per strategy module. Each strategy file imports its own version from
// here so changes are centralized.
//
// CHANGELOG (per strategy below):

//   strategy.*.2026-05-21.v1 - P3 deterministic strategy layer. Strategies
//                              consume FeatureSnapshot + RegimeContext only
//                              and emit versioned StrategySignal rows.
//   strategy.*_refined_v1.2026-05-26.v1
//                            - P5 research-only gated variants. They wrap
//                              base strategies with regime/feature gates for
//                              controlled out-of-sample refinement tests.
//   strategy.momentum_continuation_refined_v1.2026-05-27.v2
//                            - P5 8B: add short-term momentum, medium trend,
//                              macro-not-bearish, volume-not-dead, and
//                              TREND_DOWN survival-experiment gating.
//   strategy.breakout_expansion_refined_v1.2026-05-29.v2
//                            - P5 8C: specialize breakout expansion for
//                              TREND_UP/HIGH_VOL only with volatility expansion,
//                              volume, breakout-structure, trend, and macro gates.
//   strategy.trend_pullback_refined_v1.2026-05-29.v2
//                            - P5 8D: specialize trend pullback for TREND_UP
//                              and macro-confirmed HIGH_VOL with support-zone,
//                              intact-trend, momentum-reset, and reliability gates.
//   strategy.mean_reversion_refined_v1.2026-05-29.v2
//                            - P5 8E: specialize mean reversion for LOW_VOL/CHOP
//                              with oversold, range-bound, non-aggressive-vol,
//                              mean-stretch, target, and reliability gates.
export const STRATEGY_VERSIONS = {
  momentumContinuation: "strategy.momentum_continuation.2026-05-21.v1",
  trendPullback: "strategy.trend_pullback.2026-05-21.v1",
  breakoutExpansion: "strategy.breakout_expansion.2026-05-21.v1",
  meanReversionBounce: "strategy.mean_reversion_bounce.2026-05-21.v1",
  momentumContinuationRefinedV1: "strategy.momentum_continuation_refined_v1.2026-05-27.v2",
  breakoutExpansionRefinedV1: "strategy.breakout_expansion_refined_v1.2026-05-29.v2",
  trendPullbackRefinedV1: "strategy.trend_pullback_refined_v1.2026-05-29.v2",
  meanReversionRefinedV1: "strategy.mean_reversion_refined_v1.2026-05-29.v2",
} as const;

export const MOMENTUM_CONTINUATION_VERSION = STRATEGY_VERSIONS.momentumContinuation;
export const TREND_PULLBACK_VERSION = STRATEGY_VERSIONS.trendPullback;
export const BREAKOUT_EXPANSION_VERSION = STRATEGY_VERSIONS.breakoutExpansion;
export const MEAN_REVERSION_BOUNCE_VERSION = STRATEGY_VERSIONS.meanReversionBounce;

// ─── Regime detector ───────────────────────────────────────────────────────
/**
 * CHANGELOG:
 *   a6.2025-XX-XX.v1  - (existing) Initial regime detector with 6-state
 *                        classification. Lives in lib/agents/regimeDetector.ts.
 *                        Date stamp not migrated to constant; if behavior
 *                        changes after now, bump to a6.2026-05-13.v2 here.
 *   a6.2026-05-13.v1  - Reset baseline. From this point forward all regime_snapshots
 *                        rows stamp this version. Earlier rows in the DB
 *                        (if any) predate the lineage system.
 */
export const REGIME_MODEL_VERSION = "a6.2026-05-13.v1";

// ─── GPT prompt versions ───────────────────────────────────────────────────
// One per agent prompt. Bump when prompt text changes in a way that could
// alter responses. Wording polish that doesn't change semantics doesn't bump.
//
// These are baselined from the current prompts in lib/agents/*.ts. When P3+
// refactor the agents into research/commentary modules, bump these.

export const MOMENTUM_SCOUT_PROMPT_VERSION    = "momentum_scout.prompt.v1";
export const BREAKOUT_WATCHER_PROMPT_VERSION  = "breakout_watcher.prompt.v1";
export const TREND_FOLLOWER_PROMPT_VERSION    = "trend_follower.prompt.v1";
export const VOLATILITY_ARBITER_PROMPT_VERSION = "volatility_arbiter.prompt.v1";
export const MEAN_REVERSION_PROMPT_VERSION    = "mean_reversion.prompt.v1";
export const REGIME_DETECTOR_PROMPT_VERSION   = "regime_detector.prompt.v1";
export const CONFLUENCE_NARRATIVE_PROMPT_VERSION = "confluence_narrative.prompt.v1";

// ─── Model versions ────────────────────────────────────────────────────────
// The actual LLM string. Stamp this so we can tell whether differences in
// output are from prompt changes or model changes.
//
// Today all agents hardcode "gpt-4o" — that's an alias that floats over time.
// We capture what we requested; if/when we pin to a dated snapshot
// ("gpt-4o-2024-08-06"), update here.

export const LLM_MODEL_VERSION = "gpt-4o";

// ─── Confluence + Risk ────────────────────────────────────────────────────
/**
 * CHANGELOG (confluence):
 *   confluence.2026-05-13.v1 - P0 baseline: A6 filtered from votes, regime
 *                               passed as context, NEWS_SHOCK/low-reliability
 *                               hard blocks, CHOP raises threshold 1.5x,
 *                               TREND_* directional conflict softening.
 */
export const CONFLUENCE_VERSION = "confluence.2026-05-13.v1";

/**
 * CHANGELOG (risk):
 *   risk.2026-06-11.v1 - Deterministic P6A risk engine core.
 */
export const RISK_VERSION = "risk.2026-06-11.v1";

// ─── Data source versions ─────────────────────────────────────────────────
/**
 * Identifies which ingestion path produced a bar.
 *
 * CHANGELOG:
 *   coinbase.ws.v1 - Coinbase WebSocket trade aggregator (P2). 1m bars
 *                     produced live; rollups cascade locally.
 *   coinbase.rest.v1 - Coinbase REST backfill (P2). Used for historical
 *                       ingestion and gap-filling after WS disconnect.
 *   taapi.legacy    - Pre-P2 TAAPI source. Marked "legacy" so it doesn't
 *                      look like a v1 of the new pipeline.
 */
export const DATA_SOURCE_COINBASE_WS    = "coinbase.ws.v1";
export const DATA_SOURCE_COINBASE_REST  = "coinbase.rest.v1";
export const DATA_SOURCE_TAAPI_LEGACY   = "taapi.legacy";
