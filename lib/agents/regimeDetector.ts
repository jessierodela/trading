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

// Maps regime to Signal.type for dashboard rendering
const REGIME_TO_SIGNAL: Record<RegimeLabel, Signal["type"]> = {
  TREND_UP:   "buy",
  TREND_DOWN: "sell",
  LOW_VOL:    "neutral",
  HIGH_VOL:   "watch",
  CHOP:       "neutral",
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
    atrPct:      number | null;
    atrRegime:   "compressed" | "normal" | "elevated" | "extreme";
    relVol:      number | null;
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
    signal:    "BUY" | "SELL" | "WATCH" | "NEUTRAL";
    summary:   string;
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
- relativeVolume > 3.0 (volume surge ≥ 3× 20-period average)
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
    "signal": "BUY"|"SELL"|"WATCH"|"NEUTRAL",
    "summary": "string"
  }
}`;

// ─── Deterministic pre-screen ─────────────────────────────────────────────────
// Fast heuristic to flag obvious regimes before GPT call.
// Used for logging + potential short-circuit in future.

function prescreen(
  atrPct: number | null,
  candleRangeInAtr: number | null,
  relativeVolume: number | null,
): { shockCandidate: boolean; lowVolCandidate: boolean } {
  const shockCandidate =
    (atrPct != null && atrPct > 3.0) ||
    (candleRangeInAtr != null && candleRangeInAtr > 2.0) ||
    (relativeVolume != null && relativeVolume > 3.0);

  const lowVolCandidate =
    (atrPct != null && atrPct < 0.5) &&
    (candleRangeInAtr != null && candleRangeInAtr < 0.5);

  return { shockCandidate, lowVolCandidate };
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
    volume:             ind.volume        ?? null,
    prevVolume:         ind.prevVolume    ?? null,
    volumeSma20:        ind.volumeSma20   ?? null,
    relativeVolume:     derived.relativeVolume     ?? null,
    volumeAboveAverage: derived.volumeAboveAverage ?? null,

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
      `Volatility: ${volatility_context.summary}`,
      `Gate → recommend: ${recommendfmt} | caution: ${cautionfmt}`,
    ].join(" — "),
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
      relVol: derived?.relativeVolume ?? null,
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

      // Pre-screen log (advisory, not blocking)
      const entry   = snapshot.data.get(symbol);
      const derived = entry?.derived;
      const { shockCandidate, lowVolCandidate } = prescreen(
        derived?.atrPct ?? null,
        derived?.candleRangeInAtr ?? null,
        derived?.relativeVolume ?? null,
      );
      if (shockCandidate)  console.log(`[regimeDetector] ${symbol} — NEWS_SHOCK pre-screen triggered`);
      if (lowVolCandidate) console.log(`[regimeDetector] ${symbol} — LOW_VOL pre-screen triggered`);

      console.log(`[regimeDetector] Calling GPT-4o for ${symbol}...`);
      const response = await callGpt4o(payload);
      if (!response) return null;

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
