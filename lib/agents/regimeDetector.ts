/**
 * lib/agents/regimeDetector.ts
 *
 * Regime Detector Agent — A6 — GPT-4o powered.
 *
 * Role:
 *   Market regime classifier. Answers the question: "What KIND of market
 *   are we in right now?" — and gates other agents accordingly.
 *
 * Regime taxonomy (6 states):
 *   TREND_UP    — sustained bullish structure, EMA stack rising, momentum intact
 *   TREND_DOWN  — sustained bearish structure, EMA stack falling, momentum intact
 *   LOW_VOL     — compressed volatility, ATR below baseline, Bollinger squeeze
 *   HIGH_VOL    — elevated volatility, ATR expanding, wide candle ranges
 *   CHOP        — directionless mean-reversion, flat EMAs, mixed MACD
 *   NEWS_SHOCK  — abnormal spike in ATR + volume, extreme candle range, no trend context
 *
 * Pipeline (per symbol):
 *  1. Read 1H snapshot (CacheSnapshot) + 1D snapshot (CacheSnapshot1d)
 *  2. Build structured payload combining multi-timeframe context
 *  3. Call GPT-4o with the Regime Detector system prompt
 *  4. Parse response → RegimeSignal[] (extends Signal with regime metadata)
 *  5. Emit a reliability score per symbol used by the gating layer
 *
 * Gating output:
 *   Each RegimeSignal includes a `reliability` field (0–1) representing
 *   how confident the agent is that its regime classification is clean.
 *   Downstream agents (Markov engine, confluence) can use this to filter
 *   signals in low-reliability regimes (e.g. NEWS_SHOCK, CHOP).
 *
 * The agent never fetches data itself.
 * All indicator computation lives in indicatorCache.ts and indicatorCache1d.ts.
 *
 * Indicators consumed (1H):
 *   ema20, prevEma20, ema20Slope, ema20PctDist
 *   rsi, prevRsi, rsiChange
 *   macdHist, prevHist, histChange
 *   atr, atrPct, candleRangeInAtr, distanceFromEmaInAtr
 *   volume, relativeVolume, volumeAboveAverage
 *
 * Indicators consumed (1D):
 *   ema50, ema200, ema50AboveEma200, ema50Slope, ema200Slope
 *   priceAboveEma50, priceAboveEma200
 *
 * Volatility filters (deterministic pre-screen):
 *   atrPct < 0.5%             → LOW_VOL candidate
 *   atrPct > 3.0%             → HIGH_VOL / NEWS_SHOCK candidate
 *   candleRangeInAtr > 2.0    → NEWS_SHOCK candidate
 *   relativeVolume > 3.0      → NEWS_SHOCK candidate
 *
 * Trend filters (deterministic pre-screen):
 *   price above rising EMA20 + EMA50 + EMA200 → TREND_UP candidate
 *   price below falling EMA20 + EMA50 + EMA200 → TREND_DOWN candidate
 *   EMA20 flat ± 0.01, RSI 40–60, histChange near 0 → CHOP candidate
 */

import type { Signal }          from "@/lib/signals";
import type { CacheSnapshot }   from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";

// ─── Regime taxonomy ──────────────────────────────────────────────────────────

export type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "LOW_VOL"
  | "HIGH_VOL"
  | "CHOP"
  | "NEWS_SHOCK";

// Regime Detector does not emit trade signals — it emits regime context.
// All regimes map to "watch" for dashboard rendering: the regime card shows
// condition awareness, not a directional trade recommendation.
// Directional decisions belong to the agent confluence layer, not here.
const REGIME_TO_SIGNAL: Record<RegimeLabel, Signal["type"]> = {
  TREND_UP:   "watch",
  TREND_DOWN: "watch",
  LOW_VOL:    "watch",
  HIGH_VOL:   "watch",
  CHOP:       "watch",
  NEWS_SHOCK: "watch",
};

// Maps regime to confidence tier
const REGIME_TO_CONFIDENCE: Record<RegimeLabel, Signal["confidence"]> = {
  TREND_UP:   "high",
  TREND_DOWN: "high",
  LOW_VOL:    "medium",
  HIGH_VOL:   "medium",
  CHOP:       "low",
  NEWS_SHOCK: "low",
};

// ─── Extended signal type ─────────────────────────────────────────────────────

export interface RegimeSignal extends Signal {
  /** The classified regime label */
  regime: RegimeLabel;
  /**
   * Reliability score 0–1.
   * 1.0 = clean, well-defined regime (e.g. confirmed TREND_UP)
   * 0.5 = ambiguous (e.g. transitioning between regimes)
   * 0.0 = noisy / undefined (NEWS_SHOCK with no directional context)
   *
   * Used by confluence engine and Markov engine as a gating multiplier.
   */
  reliability: number;
  /** EMA slope context */
  emaContext: {
    ema20Slope:   "rising" | "falling" | "flat";
    ema50Above200: boolean | null;
  };
  /** Volatility context */
  volContext: {
    atrPct:    number | null;
    atrRegime: "compressed" | "normal" | "elevated" | "extreme";
  };
}

// ─── GPT-4o response shape ────────────────────────────────────────────────────

interface RegimeDetectorResponse {
  regime_classification: {
    label: RegimeLabel;
    confidence: "High" | "Moderate" | "Low";
    reliability_score: number;  // 0.0–1.0, injected by model
    primary_evidence: string;
    conflicting_signals: string;
  };
  trend_context: {
    ema_stack:     "aligned_bullish" | "aligned_bearish" | "mixed" | "unknown";
    ema20_slope:   "rising" | "falling" | "flat" | "unknown";
    ema50_vs_200:  "above" | "below" | "unknown";
    trend_strength: "strong" | "moderate" | "weak" | "absent" | "unknown";
    summary: string;
  };
  volatility_context: {
    atr_regime:            "compressed" | "normal" | "elevated" | "extreme" | "unknown";
    volume_regime:         "below_average" | "average" | "above_average" | "surge" | "unknown";
    shock_indicators:      "none" | "mild" | "severe" | "unknown";
    volatility_trajectory: "contracting" | "stable" | "expanding" | "unknown";
    summary: string;
  };
  gating_recommendation: {
    /**
     * Which agents should run in this regime.
     * Regime Detector does not halt agents — it issues an advisory.
     * Confluence engine applies the gate weight.
     */
    recommended_agents: Array<"momentum_scout" | "breakout_watcher" | "trend_follower" | "volatility_arbiter" | "mean_reversion" | "all">;
    /** Agents the regime makes unreliable — advisory only */
    caution_agents: Array<"momentum_scout" | "breakout_watcher" | "trend_follower" | "volatility_arbiter" | "mean_reversion" | "none">;
    rationale: string;
  };
  implication: {
    // signal removed — regime detector does not emit directional signals.
    summary: string;
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Regime Detector, a multi-timeframe market regime classification engine.

Your sole task is to classify the current market regime for a single symbol using both 1H and 1D indicator data, then emit a reliability score and gating recommendation.

You are not a trade signal generator. You are a regime-awareness layer that sits above all other agents and provides context for signal quality assessment.

You must reason in exactly four sections: Regime Classification, Trend Context, Volatility Context, Gating Recommendation.

---

## Regime Taxonomy

Choose exactly ONE from the following six regimes:

### TREND_UP
Requirements (all must be met):
- Price above EMA20 (1H) with rising slope
- EMA50 above EMA200 (1D) — bullish macro stack
- RSI in momentum zone (50–70) or momentum zone with pull-backs
- MACD histogram positive or recovering from shallow dip
- ATR normal or elevated (not extreme)
- Volume participating (relativeVolume ≥ 0.8)

### TREND_DOWN
Requirements (all must be met):
- Price below EMA20 (1H) with falling slope
- EMA50 below EMA200 (1D) OR both falling
- RSI in pullback zone (30–50) or oversold
- MACD histogram negative or turning negative
- ATR normal or elevated
- Volume participating

### LOW_VOL
Requirements (primary):
- atrPct < 0.8% (compressed absolute volatility)
- candleRangeInAtr < 0.5 (candles smaller than average ATR)
- RSI flat 45–55 — directionless
- MACD histogram near zero, low histChange
- EMA20 flat (slope < 0.01% of price per bar)
Typical context: pre-breakout accumulation or dead market

### HIGH_VOL
Requirements (primary):
- atrPct ≥ 2.0% (elevated absolute volatility)
- candleRangeInAtr 1.0–2.0 (candles tracking ATR normally)
- relativeVolume 1.5–3.0 (above average but not shock)
- Direction not undefined — still has trend structure
Distinct from NEWS_SHOCK: HIGH_VOL has structural context, NEWS_SHOCK does not

### CHOP
Requirements (primary):
- EMA20 flat (slope oscillates near zero)
- RSI oscillating 40–60 without directional bias
- MACD histogram alternating sign across bars
- No clear EMA50/EMA200 alignment advantage
- ATR normal
Typical context: range-bound sideways market, no exploitable edge

### NEWS_SHOCK
Requirements (any two or more):
- candleRangeInAtr > 2.0 (bar range > 2× ATR baseline)
- atrPct > 3.0% in a single bar
- RSI moves > 15 points in a single bar (rsiChange extreme)
- No established trend context before the shock
Typical context: macro news event, liquidation cascade, earnings surprise

---

## Reliability Score

Return a reliability_score between 0.0 and 1.0:
- 1.0: all confirming indicators align perfectly, no conflicting signals
- 0.8: strong alignment, minor mixed signals (e.g. one indicator lagging)
- 0.6: moderate alignment, some conflicting signals present
- 0.4: ambiguous — two or more regimes plausible from the data
- 0.2: low confidence — missing critical inputs or severe contradictions
- 0.0: regime undefinable from the available data

Be conservative with high scores. Reserve 0.9–1.0 for textbook-clean regimes.

---

## Gating Recommendation

For each regime, these agents are typically appropriate:
- TREND_UP:   momentum_scout, trend_follower, breakout_watcher
- TREND_DOWN: trend_follower, volatility_arbiter, mean_reversion
- LOW_VOL:    breakout_watcher (watching for squeeze break), mean_reversion
- HIGH_VOL:   volatility_arbiter, momentum_scout
- CHOP:       mean_reversion only; caution on all trend-following agents
- NEWS_SHOCK: volatility_arbiter only; caution on all others

Do not halt agents — issue an advisory only.

---

## STYLE

Disciplined, analytical. No financial advice. No disclaimers.
The implication section contains a summary string only — no signal field.
You classify regimes. You do not emit BUY, SELL, WATCH, or NEUTRAL signals.
Return ONLY a valid JSON object — no markdown, no preamble — matching this exact schema:

{
  "regime_classification": {
    "label": "TREND_UP"|"TREND_DOWN"|"LOW_VOL"|"HIGH_VOL"|"CHOP"|"NEWS_SHOCK",
    "confidence": "High"|"Moderate"|"Low",
    "reliability_score": 0.0 to 1.0,
    "primary_evidence": "string",
    "conflicting_signals": "string or none"
  },
  "trend_context": {
    "ema_stack": "aligned_bullish"|"aligned_bearish"|"mixed"|"unknown",
    "ema20_slope": "rising"|"falling"|"flat"|"unknown",
    "ema50_vs_200": "above"|"below"|"unknown",
    "trend_strength": "strong"|"moderate"|"weak"|"absent"|"unknown",
    "summary": "string"
  },
  "volatility_context": {
    "atr_regime": "compressed"|"normal"|"elevated"|"extreme"|"unknown",
    "volume_regime": "below_average"|"average"|"above_average"|"surge"|"unknown",
    "shock_indicators": "none"|"mild"|"severe"|"unknown",
    "volatility_trajectory": "contracting"|"stable"|"expanding"|"unknown",
    "summary": "string"
  },
  "gating_recommendation": {
    "recommended_agents": ["momentum_scout"|"breakout_watcher"|"trend_follower"|"volatility_arbiter"|"mean_reversion"|"all"],
    "caution_agents": ["momentum_scout"|"breakout_watcher"|"trend_follower"|"volatility_arbiter"|"mean_reversion"|"none"],
    "rationale": "string"
  },
  "implication": {
    "summary": "string"
  }
}`;

// ─── Deterministic flags ──────────────────────────────────────────────────────
//
// These flags are computed from raw indicator data BEFORE the GPT call.
// They are passed to validateRegime() AFTER the GPT call to enforce hard rules.
//
// Design principle (from review doc):
//   Determinism First — code enforces obvious conditions.
//   GPT as Interpreter — adds nuance, does not override deterministic signals.
//
// Flag thresholds:
//   shockCandidate:    atrPct > 3.0% OR candleRangeInAtr > 2.0
//                      → Hard override to NEWS_SHOCK, reliability capped at 0.6
//   lowVolCandidate:   atrPct < 0.5% AND candleRangeInAtr < 0.5
//                      → Soft constraint: if GPT disagrees, penalise reliability
//   trendUpCandidate:  priceAboveEma20 AND ema20Slope rising AND ema50AboveEma200
//                      → If GPT classifies TREND_DOWN, penalise reliability
//   trendDownCandidate: NOT priceAboveEma20 AND ema20Slope falling AND NOT ema50AboveEma200
//                      → If GPT classifies TREND_UP, penalise reliability

export interface DeterministicFlags {
  shockCandidate:     boolean;
  lowVolCandidate:    boolean;
  trendUpCandidate:   boolean;
  trendDownCandidate: boolean;
}

function computeDeterministicFlags(
  atrPct:           number | null,
  candleRangeInAtr: number | null,
  priceAboveEma20:  boolean | null,
  ema20Slope:       number | null,
  ema50AboveEma200: boolean | null,
  rsi:              number | null,
): DeterministicFlags {
  // Shock: ATR spike OR bar range blow-out
  const shockCandidate =
    (atrPct != null && atrPct > 3.0) ||
    (candleRangeInAtr != null && candleRangeInAtr > 2.0);

  // Low vol: both ATR and candle range compressed
  const lowVolCandidate =
    (atrPct != null && atrPct < 0.5) &&
    (candleRangeInAtr != null && candleRangeInAtr < 0.5);

  // Trend up: price above EMA20, slope rising, macro stack bullish
  const trendUpCandidate =
    priceAboveEma20 === true &&
    (ema20Slope != null && ema20Slope > 0) &&
    ema50AboveEma200 === true;

  // Trend down: price below EMA20, slope falling, macro stack bearish
  const trendDownCandidate =
    priceAboveEma20 === false &&
    (ema20Slope != null && ema20Slope < 0) &&
    ema50AboveEma200 === false;

  return { shockCandidate, lowVolCandidate, trendUpCandidate, trendDownCandidate };
}

// ─── Validation layer ─────────────────────────────────────────────────────────
//
// Runs AFTER GPT response, BEFORE toRegimeSignal().
// Enforces deterministic constraints that GPT cannot override.
//
// Hard overrides (code always wins):
//   shockCandidate → label forced to NEWS_SHOCK, reliability capped at 0.6
//
// Soft penalties (GPT disagreement reduces trust, not overrides):
//   lowVolCandidate + GPT not LOW_VOL  → reliability × 0.75
//   trendUpCandidate + GPT = TREND_DOWN → reliability × 0.75
//   trendDownCandidate + GPT = TREND_UP  → reliability × 0.75
//
// This implements the review doc architecture:
//   deterministic flags → GPT reasoning → validation → final output

function validateRegime(
  response:  RegimeDetectorResponse,
  flags:     DeterministicFlags,
): RegimeDetectorResponse {
  let label       = response.regime_classification.label;
  let reliability = Math.min(1, Math.max(0, response.regime_classification.reliability_score ?? 0.5));

  // ── Hard override: shock ───────────────────────────────────────────────────
  if (flags.shockCandidate) {
    if (label !== "NEWS_SHOCK") {
      console.log(
        `[regimeDetector] HARD OVERRIDE: shock flags set, GPT returned ${label} — forcing NEWS_SHOCK`
      );
      label = "NEWS_SHOCK";
    }
    // Cap reliability regardless — shock conditions are inherently unstable
    reliability = Math.min(reliability, 0.6);
  }

  // ── Soft penalty: low vol disagreement ────────────────────────────────────
  if (flags.lowVolCandidate && label !== "LOW_VOL") {
    const before = reliability;
    reliability = +(reliability * 0.75).toFixed(3);
    console.log(
      `[regimeDetector] SOFT PENALTY: lowVol flags set but GPT returned ${label} — ` +
      `reliability ${before} → ${reliability}`
    );
  }

  // ── Soft penalty: trend direction contradiction ────────────────────────────
  if (flags.trendUpCandidate && label === "TREND_DOWN") {
    const before = reliability;
    reliability = +(reliability * 0.75).toFixed(3);
    console.log(
      `[regimeDetector] SOFT PENALTY: trendUp flags set but GPT returned TREND_DOWN — ` +
      `reliability ${before} → ${reliability}`
    );
  }

  if (flags.trendDownCandidate && label === "TREND_UP") {
    const before = reliability;
    reliability = +(reliability * 0.75).toFixed(3);
    console.log(
      `[regimeDetector] SOFT PENALTY: trendDown flags set but GPT returned TREND_UP — ` +
      `reliability ${before} → ${reliability}`
    );
  }

  return {
    ...response,
    regime_classification: {
      ...response.regime_classification,
      label,
      reliability_score: reliability,
    },
  };
}

// ─── Payload builder ──────────────────────────────────────────────────────────

function buildPayload(
  symbol: string,
  snapshot:   CacheSnapshot,
  snapshot1d: CacheSnapshot1d,
): object | null {
  const entry   = snapshot.data.get(symbol);
  const entry1d = snapshot1d.data.get(symbol);

  if (!entry) return null;

  const { indicators: ind, derived } = entry;

  // 1D fields — gracefully null if 1D cache unavailable
  const ind1d     = entry1d?.indicators;
  const derived1d = entry1d?.derived;

  return {
    symbol,

    // ── 1H: Price / EMA ──────────────────────────────────────────────────
    currentClose:    ind.currentClose,
    ema20:           ind.ema20,
    prevEma20:       ind.prevEma20,
    ema20Slope:      derived.ema20Slope,
    ema20PctDist:    derived.ema20PctDist,
    priceAboveEma20: derived.priceAboveEma20,

    // ── 1H: RSI ──────────────────────────────────────────────────────────
    rsi:      ind.rsi,
    prevRsi:  ind.prevRsi,
    rsiChange: derived.rsiChange,

    // ── 1H: MACD ─────────────────────────────────────────────────────────
    macdHist:   ind.macd?.valueMACDHist ?? null,
    prevHist:   ind.prevHist,
    histChange: derived.histChange,

    // ── 1H: Volatility ────────────────────────────────────────────────────
    atr:                  ind.atr,
    atrPct:               derived.atrPct,
    candleRangeInAtr:     derived.candleRangeInAtr,
    distanceFromEmaInAtr: derived.distanceFromEmaInAtr,

    // ── 1H: Volume ────────────────────────────────────────────────────────
    // Volume fields excluded: yahoo-finance2 session volume vs taapi 1H bar volume
    // are incompatible units — all volume-derived ratios produce garbage values.
    // ATR and candleRangeInAtr are the reliable volatility signals here.

    // ── 1D: EMA stack ─────────────────────────────────────────────────────
    ema50:           ind1d?.ema50                ?? null,
    ema200:          ind1d?.ema200               ?? null,
    ema50AboveEma200: derived1d?.ema50AboveEma200 ?? null,
    ema50Slope:      derived1d?.ema50Slope       ?? null,
    ema200Slope:     derived1d?.ema200Slope      ?? null,
    priceAboveEma50:  derived1d?.priceAboveEma50  ?? null,
    priceAboveEma200: derived1d?.priceAboveEma200 ?? null,
  };
}

// ─── GPT-4o call ──────────────────────────────────────────────────────────────

async function callGpt4o(payload: object): Promise<RegimeDetectorResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[regimeDetector] OPENAI_API_KEY not set");
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "gpt-4o",
        temperature: 0,
        max_tokens:  1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: JSON.stringify(payload, null, 2) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[regimeDetector] GPT-4o error ${res.status}:`, err);
      return null;
    }

    const data         = await res.json();
    const choice       = data.choices?.[0];
    const raw          = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason as string | undefined;

    if (finishReason === "length") {
      console.warn("[regimeDetector] GPT-4o response truncated — increase max_tokens");
    }

    const clean = raw.replace(/```json|```/gi, "").trim();

    try {
      return JSON.parse(clean) as RegimeDetectorResponse;
    } catch {
      console.error(`[regimeDetector] JSON.parse failed. finish_reason=${finishReason}. Raw:`, raw);
      return null;
    }

  } catch (err) {
    console.error("[regimeDetector] Fetch error:", err);
    return null;
  }
}

// ─── Response → RegimeSignal ──────────────────────────────────────────────────

function toRegimeSignal(
  response: RegimeDetectorResponse,
  symbol:   string,
  snapshot: CacheSnapshot,
): RegimeSignal {
  const { regime_classification, trend_context, volatility_context, gating_recommendation, implication } = response;

  const label = regime_classification.label;
  const entry = snapshot.data.get(symbol);
  const derived = entry?.derived;

  // EMA20 slope bucket
  const ema20SlopeRaw = derived?.ema20Slope ?? null;
  const ema20SlopeBucket: "rising" | "falling" | "flat" =
    ema20SlopeRaw == null ? "flat"
    : ema20SlopeRaw > 0.01 ? "rising"
    : ema20SlopeRaw < -0.01 ? "falling"
    : "flat";

  // ATR regime bucket
  const atrPct = derived?.atrPct ?? null;
  const atrRegime: "compressed" | "normal" | "elevated" | "extreme" =
    atrPct == null       ? "normal"
    : atrPct < 0.5       ? "compressed"
    : atrPct < 1.5       ? "normal"
    : atrPct < 3.0       ? "elevated"
    : "extreme";

  const reliability = Math.min(1, Math.max(0, regime_classification.reliability_score ?? 0.5));

  const cautionfmt = gating_recommendation.caution_agents.join(", ") || "none";
  const recommendfmt = gating_recommendation.recommended_agents.join(", ");

  return {
    symbol,
    agent:      "Regime Detector",
    type:       REGIME_TO_SIGNAL[label],
    confidence: REGIME_TO_CONFIDENCE[label],
    reason: [
      `[${label}] ${implication.summary}`,
      `Trend: ${trend_context.summary}`,
      `Vol: ${volatility_context.summary}`,
      `Gate → ${recommendfmt} | caution: ${cautionfmt}`,
    ].join(" | "),
    regime:      label,
    reliability,
    emaContext: {
      ema20Slope:    ema20SlopeBucket,
      ema50Above200: trend_context.ema50_vs_200 === "above" ? true
                   : trend_context.ema50_vs_200 === "below" ? false
                   : null,
    },
    volContext: {
      atrPct,
      atrRegime,
      // No volume field: yahoo session vol and taapi 1H bar vol are incompatible.
      // ATR regime and atrPct carry the volatility signal reliably.
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run Regime Detector across all symbols in the 1H cache.
 * Also consumes 1D snapshot for EMA50/200 macro context.
 * Returns RegimeSignal[] — a superset of Signal[].
 */
export async function runRegimeDetector(
  snapshot:   CacheSnapshot,
  snapshot1d: CacheSnapshot1d,
  symbols?:   string[],
): Promise<RegimeSignal[]> {
  const targets = symbols ?? [
    ...snapshot.stockSymbols,
    ...snapshot.cryptoSymbols,
  ];

  const signals: RegimeSignal[] = [];

  const results = await Promise.allSettled(
    targets.map(async (symbol) => {
      const payload = buildPayload(symbol, snapshot, snapshot1d);
      if (!payload) {
        console.log(`[regimeDetector] No cache data for ${symbol} — skipping`);
        return null;
      }


      // ── Step 1: Compute deterministic flags from raw data ─────────────
      const entry   = snapshot.data.get(symbol);
      const derived = entry?.derived;
      const flags   = computeDeterministicFlags(
        derived?.atrPct           ?? null,
        derived?.candleRangeInAtr ?? null,
        derived?.priceAboveEma20  ?? null,
        derived?.ema20Slope       ?? null,
        snapshot1d.data.get(symbol)?.derived?.ema50AboveEma200 ?? null,
        entry?.indicators?.rsi    ?? null,
      );

      if (flags.shockCandidate)     console.log(`[regimeDetector] ${symbol} — SHOCK flags set (will hard-override GPT)`);
      if (flags.lowVolCandidate)    console.log(`[regimeDetector] ${symbol} — LOW_VOL flags set`);
      if (flags.trendUpCandidate)   console.log(`[regimeDetector] ${symbol} — TREND_UP flags set`);
      if (flags.trendDownCandidate) console.log(`[regimeDetector] ${symbol} — TREND_DOWN flags set`);

      // ── Step 2: GPT-4o classification ──────────────────────────────────
      console.log(`[regimeDetector] Calling GPT-4o for ${symbol}...`);
      const rawResponse = await callGpt4o(payload);
      if (!rawResponse) return null;

      // ── Step 3: Validate — enforce deterministic constraints ────────────
      const response = validateRegime(rawResponse, flags);

      if (response.regime_classification.label !== rawResponse.regime_classification.label) {
        console.log(
          `[regimeDetector] ${symbol} — validated: ${rawResponse.regime_classification.label} → ${response.regime_classification.label}`
        );
      }

      return toRegimeSignal(response, symbol, snapshot);
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      signals.push(result.value);
    }
  }

  return signals;
}

/**
 * Get the regime label for a symbol from a completed RegimeSignal[].
 * Convenience helper for downstream agents.
 */
export function getRegimeForSymbol(
  regimeSignals: RegimeSignal[],
  symbol: string,
): RegimeLabel | null {
  return regimeSignals.find((s) => s.symbol === symbol)?.regime ?? null;
}

/**
 * Get the reliability score for a symbol.
 * Returns 1.0 (full trust) if regime detector didn't run for this symbol.
 */
export function getReliabilityForSymbol(
  regimeSignals: RegimeSignal[],
  symbol: string,
): number {
  return regimeSignals.find((s) => s.symbol === symbol)?.reliability ?? 1.0;
}
