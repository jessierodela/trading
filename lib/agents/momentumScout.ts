/**
 * lib/agents/momentumScout.ts
 *
 * Momentum Scout Agent — GPT-4o powered.
 *
 * Pipeline (per symbol):
 *  1. Read pre-fetched, pre-derived data from indicatorCache (instant)
 *  2. Build structured JSON input payload matching the prompt schema
 *  3. Call GPT-4o with the Momentum Scout system prompt
 *  4. Parse the JSON response into the existing Signal type
 *  5. Return Signal[] — drop-in replacement for the hardcoded momentumScout()
 *
 * The agent never fetches data itself.
 * All indicator + derived field computation lives in indicatorCache.ts.
 *
 * v2 additions:
 *  - Volume: volume, prevVolume, volumeChangePct, volumeSma20, relativeVolume,
 *            volumeExpanding, volumeAboveAverage
 *  - ATR context: atr, atrPct, distanceFromEmaInAtr, candleRangeInAtr
 *
 * CHANGE LOG:
 *  - Output shape standardized to structure / momentum_conditions / implication,
 *    matching BreakoutWatcher, TrendFollower, VolatilityArbiter, MeanReversion.
 *    classification moves inside structure.momentum_classification.
 *    reasoning/key_factors replaced by section summaries + implication.summary.
 *    toSignal() updated to read from new shape.
 *    Fallback reasoning generator removed — implication.summary is now required.
 */

import type { Signal }        from "@/lib/signals";
import type { CacheSnapshot } from "@/lib/indicatorCache";

// ─── Classification taxonomy ───────────────────────────────────────────────
// Unchanged — same 8 categories, same signal mapping.

type MomentumClassification =
  | "acceleration"
  | "trend_continuation"
  | "pullback_to_support"
  | "extended_but_strong"
  | "decelerating"
  | "rollover_risk"
  | "oversold_bounce"
  | "neutral";

const CLASSIFICATION_TO_SIGNAL: Record<MomentumClassification, Signal["type"]> = {
  acceleration:        "buy",
  trend_continuation:  "buy",
  pullback_to_support: "buy",
  extended_but_strong: "watch",
  decelerating:        "watch",
  rollover_risk:       "sell",
  oversold_bounce:     "watch",
  neutral:             "neutral",
};

// ─── GPT-4o response shape ─────────────────────────────────────────────────
// Standardized to structure / momentum_conditions / implication.
// Matches the envelope used by all other agents.

interface MomentumScoutResponse {
  structure: {
    /** Price location relative to EMA20 */
    price_vs_ema20:     "above" | "below" | "at" | "unknown";
    /** EMA20 slope direction */
    ema20_slope:        "rising" | "falling" | "flat" | "unknown";
    /** Overall short-term structural bias */
    trend_bias:         "bullish" | "bearish" | "mixed" | "unknown";
    /** The single best-fit momentum classification */
    momentum_classification: MomentumClassification;
    summary: string;
  };
  momentum_conditions: {
    rsi_regime:         "oversold" | "pullback_zone" | "momentum_zone" | "overbought" | "unknown";
    rsi_direction:      "rising" | "falling" | "flat" | "unknown";
    histogram_sign:     "positive" | "negative" | "zero" | "unknown";
    histogram_direction: "expanding" | "contracting" | "flat" | "unknown";
    volume_context:     "strong" | "moderate" | "weak" | "unknown";
    extension_state:    "normal" | "extended" | "deeply_extended" | "unknown";
    summary: string;
  };
  implication: {
    signal:     "BUY" | "SELL" | "WATCH" | "NEUTRAL";
    confidence: "High" | "Moderate" | "Low";
    summary:    string;
  };
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Momentum Scout, a technical momentum classification engine.

Your job is to analyze structured technical indicator data for a single symbol on a single timeframe and classify the current momentum state using RSI, MACD, EMA20, volume context, and derived bar-to-bar changes.

You are not a chatbot and you are not a financial advisor. You are a deterministic market-state classifier. Your task is to produce a disciplined, conservative classification from the supplied data only.

You must reason in exactly three sections: Structure, Momentum Conditions, Implication.

---

## Core Principles

Treat the indicators as a unified momentum framework:

- EMA20 defines structure and short-term trend
- RSI defines momentum regime and extension/exhaustion
- MACD histogram defines momentum strength and change
- Volume defines participation and confirmation
- ATR defines normalized volatility and extension

---

## STRUCTURE

Assess:
- price_vs_ema20: is currentClose above, below, or at EMA20?
- ema20_slope: is EMA20 rising, falling, or flat (compare ema20 vs prevEma20)?
- trend_bias: bullish if price above rising EMA20; bearish if below falling EMA20; mixed otherwise
- momentum_classification: choose ONE from the list below

### Classification definitions

acceleration:
- bullish structure intact (price above rising EMA20)
- histogram positive and expanding (histChange > 0)
- RSI rising (rsiChange > 0) and in momentum zone (55–75)
- strong or moderate volume participation

trend_continuation:
- bullish structure intact
- histogram positive, momentum stable (not accelerating)
- RSI 50–70

pullback_to_support:
- bullish structure intact (trend still up)
- RSI cooled to 40–50
- histogram still positive
- price near EMA20 (ema20PctDist within -2% to +4%)

extended_but_strong:
- RSI elevated (70–78) but histogram still expanding
- price meaningfully above EMA20 (ema20PctDist > 4%)
- no clear weakness yet

decelerating:
- histogram positive but contracting (histChange < 0)
- RSI above 70 and cooling
- structure still intact

rollover_risk:
- histogram turning negative OR already negative
- price losing EMA20 support OR EMA20 slope weakening
- multiple weakness signals present

oversold_bounce:
- RSI low (below 35) or rising from sub-40
- histogram improving (less negative or turning positive)
- structure still weak overall

neutral:
- mixed or unclear signals; no strong directional edge

---

## MOMENTUM CONDITIONS

Assess:
- rsi_regime: oversold (<35) | pullback_zone (35–50) | momentum_zone (50–70) | overbought (>70)
- rsi_direction: is RSI rising or falling vs prevRsi?
- histogram_sign: is macdHist positive or negative?
- histogram_direction: is histogram expanding or contracting vs prevHist?
- volume_context: relativeVolume >1.2 = strong; 0.8–1.2 = moderate; <0.8 = weak
- extension_state: use distanceFromEmaInAtr — normal (<1.0 ATR), extended (1–2 ATR), deeply_extended (>2 ATR)

---

## IMPLICATION

Combine structure and momentum:
- BUY: acceleration, trend_continuation, pullback_to_support
- SELL: rollover_risk
- WATCH: extended_but_strong, decelerating, oversold_bounce
- NEUTRAL: neutral / unclear

Confidence:
- High: strong alignment across all factors
- Moderate: some mixed signals
- Low: weak or missing data

Reduce confidence if: missing prev values, missing volume context, missing EMA structure.

---

## STYLE

Concise, analytical, disciplined. No hype. No disclaimers. No chain-of-thought visible in output.

Return ONLY a valid JSON object — no markdown, no preamble — matching this exact schema:
{
  "structure": {
    "price_vs_ema20": "above"|"below"|"at"|"unknown",
    "ema20_slope": "rising"|"falling"|"flat"|"unknown",
    "trend_bias": "bullish"|"bearish"|"mixed"|"unknown",
    "momentum_classification": "acceleration"|"trend_continuation"|"pullback_to_support"|"extended_but_strong"|"decelerating"|"rollover_risk"|"oversold_bounce"|"neutral",
    "summary": "string"
  },
  "momentum_conditions": {
    "rsi_regime": "oversold"|"pullback_zone"|"momentum_zone"|"overbought"|"unknown",
    "rsi_direction": "rising"|"falling"|"flat"|"unknown",
    "histogram_sign": "positive"|"negative"|"zero"|"unknown",
    "histogram_direction": "expanding"|"contracting"|"flat"|"unknown",
    "volume_context": "strong"|"moderate"|"weak"|"unknown",
    "extension_state": "normal"|"extended"|"deeply_extended"|"unknown",
    "summary": "string"
  },
  "implication": {
    "signal": "BUY"|"SELL"|"WATCH"|"NEUTRAL",
    "confidence": "High"|"Moderate"|"Low",
    "summary": "string"
  }
}`;

// ─── Payload builder ───────────────────────────────────────────────────────
// Unchanged — same fields sent to GPT, same null handling.

function buildPayload(symbol: string, snapshot: CacheSnapshot): object | null {
  const entry = snapshot.data.get(symbol);
  if (!entry) return null;

  const { indicators: ind, derived } = entry;

  return {
    symbol,
    timeframe: "1h",

    // ── Price / EMA ──────────────────────────────────────────────
    currentClose:    ind.currentClose,
    ema20:           ind.ema20,
    prevEma20:       ind.prevEma20,
    priceAboveEma20: derived.priceAboveEma20,
    ema20Slope:      derived.ema20Slope,
    ema20PctDist:    derived.ema20PctDist,

    // ── RSI ──────────────────────────────────────────────────────
    rsi:             ind.rsi,
    prevRsi:         ind.prevRsi,
    rsiChange:       derived.rsiChange,

    // ── MACD ─────────────────────────────────────────────────────
    macdHist:        ind.macd?.valueMACDHist   ?? null,
    macdValue:       ind.macd?.valueMACD        ?? null,
    macdSignal:      ind.macd?.valueMACDSignal  ?? null,
    prevHist:        ind.prevHist,
    histChange:      derived.histChange,

    // ── Volume ───────────────────────────────────────────────────
    volume:             ind.volume            ?? null,
    prevVolume:         ind.prevVolume         ?? null,
    volumeSma20:        ind.volumeSma20        ?? null,
    volumeChangePct:    derived.volumeChangePct   ?? null,
    relativeVolume:     derived.relativeVolume     ?? null,
    volumeExpanding:    derived.volumeExpanding    ?? null,
    volumeAboveAverage: derived.volumeAboveAverage ?? null,

    // ── ATR / Volatility context ─────────────────────────────────
    atr:                  ind.atr                     ?? null,
    atrPct:               derived.atrPct               ?? null,
    distanceFromEmaInAtr: derived.distanceFromEmaInAtr ?? null,
    candleRangeInAtr:     derived.candleRangeInAtr     ?? null,
  };
}

// ─── GPT-4o call ──────────────────────────────────────────────────────────
// Unchanged — same model, temperature, max_tokens, error handling.

async function callGpt4o(payload: object): Promise<MomentumScoutResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[momentumScout] OPENAI_API_KEY not set");
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
        max_tokens:  900,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: JSON.stringify(payload, null, 2) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[momentumScout] GPT-4o error ${res.status}:`, err);
      return null;
    }

    const data         = await res.json();
    const choice       = data.choices?.[0];
    const raw          = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason as string | undefined;

    if (finishReason === "length") {
      console.warn("[momentumScout] GPT-4o response truncated (finish_reason=length) — increase max_tokens");
    }

    const clean = raw.replace(/```json|```/gi, "").trim();

    try {
      return JSON.parse(clean) as MomentumScoutResponse;
    } catch {
      console.error(`[momentumScout] JSON.parse failed. finish_reason=${finishReason}. Raw:`, raw);
      return null;
    }

  } catch (err) {
    console.error("[momentumScout] Fetch error:", err);
    return null;
  }
}

// ─── Response → Signal ────────────────────────────────────────────────────
// Reads from the new structure/momentum_conditions/implication shape.
// reason array matches the 4-line pattern used by all other agents.

function toSignal(
  response: MomentumScoutResponse,
  symbol:   string,
): Signal {
  const { structure, momentum_conditions, implication } = response;

  const classification = structure.momentum_classification ?? "neutral";
  const type = CLASSIFICATION_TO_SIGNAL[classification] ?? "neutral";

  return {
    symbol,
    agent:      "Momentum Scout",
    type,
    confidence: implication.confidence === "High"     ? "high"
              : implication.confidence === "Moderate" ? "medium"
              : "low",
    reason: [
      `[${implication.signal}] ${implication.summary}`,
      `Structure: ${structure.summary}`,
      `Momentum: ${momentum_conditions.summary}`,
      `Classification: ${classification} | Vol: ${momentum_conditions.volume_context}`,
    ].join(" — "),
    tags: [classification.replace("_risk", "") as any],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run Momentum Scout across all symbols in the cache.
 * Calls GPT-4o once per symbol — results are independent.
 * Returns Signal[] compatible with the AgentResult / refresh pipeline.
 */
export async function runMomentumScoutAI(
  snapshot: CacheSnapshot,
  symbols?: string[]
): Promise<Signal[]> {
  const targets = symbols ?? [
    ...snapshot.stockSymbols,
    ...snapshot.cryptoSymbols,
  ];

  const signals: Signal[] = [];

  const results = await Promise.allSettled(
    targets.map(async (symbol) => {
      const payload = buildPayload(symbol, snapshot);
      if (!payload) {
        console.log(`[momentumScout] No cache data for ${symbol} — skipping`);
        return null;
      }

      console.log(`[momentumScout] Calling GPT-4o for ${symbol}...`);
      const response = await callGpt4o(payload);
      if (!response) return null;

      return toSignal(response, symbol);
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      signals.push(result.value);
    }
  }

  return signals;
}
