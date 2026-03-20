/**
 * lib/agents/momentumScout.ts
 *
 * Momentum Scout AI Agent — GPT-4o powered.
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
 */

import type { Signal }        from "@/lib/signals";
import type { CacheSnapshot } from "@/lib/indicatorCache";

// ─── GPT-4o response schema ────────────────────────────────────────────────
// Must match the classification taxonomy in the system prompt exactly.

type MomentumClassification =
  | "acceleration"
  | "trend_continuation"
  | "pullback_to_support"
  | "extended_but_strong"
  | "decelerating"
  | "rollover_risk"
  | "oversold_bounce"
  | "neutral";

interface MomentumScoutResponse {
  symbol:         string;
  classification: MomentumClassification;
  signal_type:    "buy" | "sell" | "watch" | "neutral";
  confidence:     "high" | "medium" | "low";
  reasoning:      string;   // 1–3 sentence plain-English explanation
  key_factors:    string[]; // 2–4 bullet-point factors that drove the call
}

// ─── Classification → SignalType mapping ──────────────────────────────────
// Mirrors the "Signal Type Mapping" section of the system prompt.

const CLASSIFICATION_TO_SIGNAL: Record<MomentumClassification, Signal["type"]> = {
  acceleration:        "buy",
  trend_continuation:  "buy",
  pullback_to_support: "buy",
  extended_but_strong: "watch",
  decelerating:        "watch",
  rollover_risk:       "sell",
  oversold_bounce:     "watch",
  neutral:             "none",
};

// ─── System prompt ─────────────────────────────────────────────────────────
// Loaded once — do not inline into the per-symbol call to avoid repetition.

const SYSTEM_PROMPT = `You are Momentum Scout AI, a technical momentum classification engine.

Your job is to analyze structured technical indicator data for a single symbol on a single timeframe and classify the current momentum state using RSI, MACD, EMA20, volume context, and derived bar-to-bar changes.

You are not a chatbot and you are not a financial advisor. You are a deterministic market-state classifier. Your task is to produce a disciplined, conservative classification from the supplied data only.

---

## Core Principles

Treat the indicators as a unified momentum framework:

- EMA20 defines structure and short-term trend
- RSI defines momentum regime and extension/exhaustion
- MACD histogram defines momentum strength and change
- Volume defines participation and confirmation
- ATR defines normalized volatility and extension

---

## Required Reasoning Order

You MUST evaluate and reason in this order:

### 1. Structure
Assess:
- price relative to EMA20
- EMA20 slope
- whether structure is bullish, bearish, or mixed

### 2. Momentum
Assess:
- RSI level and RSI change
- MACD histogram sign (positive/negative)
- MACD histogram change (expanding/contracting)
- volume context (relative volume, expansion or contraction)

### 3. Implication
Determine the most likely short-term outcome:
- continuation
- pullback
- consolidation
- extension
- deceleration
- rollover risk

---

## Summary Output Format (STRICT)

The summary MUST follow this structure:

- Sentence 1: Structure
- Sentence 2: Momentum
- Sentence 3: Implication

Example format:
"Price remains above a rising EMA20, confirming bullish short-term structure. Momentum is still positive, but the MACD histogram is shrinking and RSI has cooled. This suggests deceleration, with consolidation or a shallow pullback likely."

---

## Interpretation Rules

### Trend Context
- Bullish:
  priceAboveEma20 = true AND ema20Slope > 0
- Bearish:
  priceAboveEma20 = false AND ema20Slope < 0
- Otherwise:
  neutral or mixed

---

### RSI Regime
- RSI > 70 is NOT automatically bearish
- RSI < 30 is NOT automatically bullish

Bull trend:
- 40–50 → pullback support
- 50–70 → healthy momentum
- 70–85 → strong or extended

Bear trend:
- 50–60 → resistance
- <40 → weak

---

### MACD / Histogram
- hist > 0 → positive momentum
- hist < 0 → negative momentum
- histChange > 0 → strengthening
- histChange < 0 → weakening

---

### Volume Context
- relativeVolume > 1.2 → strong participation
- increasing volume supports continuation
- declining volume suggests weakening participation
- high volume on downside increases rollover risk

---

### ATR / Extension Context
- ATR normalizes movement size
- distance from EMA20 should be evaluated relative to ATR, not just %
- large ATR-based extension increases pullback risk

---

## Classification Logic

Choose ONE:

- acceleration
- trend_continuation
- pullback_to_support
- extended_but_strong
- decelerating
- rollover_risk
- oversold_bounce
- neutral

---

### Definitions

acceleration:
- bullish structure intact
- histogram positive and expanding
- RSI rising
- strong participation

trend_continuation:
- bullish structure intact
- momentum positive but stable

pullback_to_support:
- bullish structure intact
- RSI cooled (40–50)
- price near EMA20

extended_but_strong:
- RSI elevated OR price extended
- histogram still positive
- no clear weakness yet

decelerating:
- histogram positive but shrinking
- RSI cooling
- structure still intact

rollover_risk:
- histogram negative OR turning negative
- price losing EMA20 OR slope weakening
- multiple weakness signals

oversold_bounce:
- RSI low
- histogram improving
- weak unless structure recovers

neutral:
- mixed or unclear

---

## Signal Mapping

- acceleration → buy
- trend_continuation → buy
- pullback_to_support → buy
- extended_but_strong → watch
- decelerating → watch
- rollover_risk → sell
- oversold_bounce → watch
- neutral → neutral

---

## Confidence Rules

- high → strong alignment
- medium → some mixed signals
- low → weak or missing data

Reduce confidence if:
- missing prev values
- missing volume context
- missing EMA structure

---

## Output Rules

- Use ONLY provided data
- Do NOT hallucinate
- Do NOT add external factors
- Be conservative
- Prefer neutral over weak signals
- Return ONLY valid JSON
- No markdown
- No extra commentary`;

// ─── Payload builder ───────────────────────────────────────────────────────
// Builds the structured JSON the prompt receives as user message.
// Null fields are included explicitly so the model knows data is missing.

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
    // Raw values (from indicatorCache / yahoo-finance2)
    volume:            ind.volume            ?? null,
    prevVolume:        ind.prevVolume         ?? null,
    volumeSma20:       ind.volumeSma20        ?? null,
    // Derived — computed in indicatorCache.ts
    volumeChangePct:   derived.volumeChangePct   ?? null,  // ((volume - prevVolume) / prevVolume) * 100
    relativeVolume:    derived.relativeVolume     ?? null,  // volume / volumeSma20
    volumeExpanding:   derived.volumeExpanding    ?? null,  // volume > prevVolume
    volumeAboveAverage: derived.volumeAboveAverage ?? null, // volume > volumeSma20

    // ── ATR / Volatility context ─────────────────────────────────
    // Raw ATR from taapi (already present in most setups)
    atr:                 ind.atr                    ?? null,
    // Derived — computed in indicatorCache.ts
    atrPct:              derived.atrPct              ?? null,  // (atr / currentClose) * 100
    distanceFromEmaInAtr: derived.distanceFromEmaInAtr ?? null, // (currentClose - ema20) / atr
    candleRangeInAtr:    derived.candleRangeInAtr    ?? null,  // (high - low) / atr (requires candle high/low)
  };
}

// ─── GPT-4o call ──────────────────────────────────────────────────────────

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
        temperature: 0,    // deterministic — we want consistency, not creativity
        max_tokens:  900,  // reasoning (3 sentences) + key_factors (4 items) + JSON overhead ~800 tokens
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

    // Detect truncation — if finish_reason is "length" the JSON is incomplete
    if (finishReason === "length") {
      console.warn(`[momentumScout] GPT-4o response truncated (finish_reason=length) — increase max_tokens`);
    }

    // Strip any accidental markdown fences before parsing
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

function toSignal(response: MomentumScoutResponse, symbol: string): Signal {
  const type = CLASSIFICATION_TO_SIGNAL[response.classification] ?? "none";

  const keyFactorStr = response.key_factors?.length
    ? ` — ${response.key_factors.join("; ")}`
    : "";

  return {
    symbol,   // always the known local value, never response.symbol
    agent:      "Momentum Scout AI",
    type,
    reason:     `[${response.classification}] ${response.reasoning ?? "no reasoning returned"}${keyFactorStr}`,
    confidence: response.confidence,
    tags:       [response.classification.replace("_risk", "") as any],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run Momentum Scout AI across all symbols in the cache.
 * Calls GPT-4o once per symbol — results are independent.
 * Returns Signal[] compatible with the existing evaluateSignals() shape.
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

  // Run all symbols in parallel — GPT-4o calls are independent
  const results = await Promise.allSettled(
    targets.map(async (symbol) => {
      const payload = buildPayload(symbol, snapshot);
      if (!payload) {
        console.warn(`[momentumScout] No cache data for ${symbol} — skipping`);
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
