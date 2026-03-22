/**
 * lib/signals.ts
 * Converts raw Taapi indicator values → agent signals, activity log entries,
 * and StatsBar counts. This is the "brain" that each agent uses.
 *
 * Agents:
 *  A1 — Momentum Scout:     RSI + MACD + EMA20 — ALL symbols
 *  A2 — Breakout Watcher:   Bollinger Band breakouts — ALL symbols
 *  A3 — Trend Follower:     EMA 50/200 cross — stocks only
 *  A4 — Mean Reversion:     Deep RSI oversold — ALL symbols
 *  A5 — Volatility Arbiter: ATR spike — ALL symbols
 */

import type { IndicatorValues } from "./taapi";

export type SignalType = "buy" | "sell" | "watch" | "neutral" | "none";

/**
 * Phase 4 — Momentum tags give AI a structured funnel instead of raw buy/sell/watch.
 * Multiple tags can apply to one signal.
 */
export type MomentumTag =
  | "trend_continuation"
  | "pullback_to_support"
  | "acceleration"
  | "extended_but_strong"
  | "decelerating"
  | "rollover"
  | "oversold_bounce";

export interface Signal {
  symbol:     string;
  agent:      string;
  type:       SignalType;
  reason:     string;
  confidence: "high" | "medium" | "low";
  /** Phase 4: structured momentum tags — only set by Momentum Scout */
  tags?:      MomentumTag[];
  /** Phase 3: bar-to-bar context for display or AI downstream */
  context?: {
    ema20PctDistance?: number; // % price is above/below EMA20
    ema20Slope?:       number; // EMA20[cur] - EMA20[prev]
    histChange?:       number; // histogram[cur] - histogram[prev]
    rsiChange?:        number; // RSI[cur] - RSI[prev]
  };
}

export interface AgentResult {
  id:          string;
  name:        string;
  signalCount: number;
  alertCount:  number;
  lastAction:  string;
  signals:     Signal[];
}

export interface DashboardStats {
  activeAgents:   number;
  alertsToday:    number;
  buySignals:     number;
  highConfidence: number;
}

// ─── Per-agent signal logic ────────────────────────────────────────────────

/**
 * A1 — Momentum Scout
 * Covers ALL symbols (stocks + crypto).
 *
 * Phase 1 (original): EMA20 + RSI + MACD
 * Phase 2 (upgrade):  Bar-to-bar change — prevRsi, prevHist, prevEma20, currentClose, prevClose
 * Phase 3 (upgrade):  Position context — % distance from EMA20, EMA20 slope
 * Phase 4 (upgrade):  Momentum tagging — acceleration, deceleration, rollover, etc.
 *
 * Signal priority (EMA20-enabled path):
 *  1. ACCELERATION       — all engines firing, highest-conviction BUY
 *  2. TREND CONTINUATION — MACD crossover + RSI in momentum zone
 *  3. PULLBACK TO SUPPORT — healthy dip to EMA20
 *  4. DECELERATION       — histogram shrinking + RSI overbought (WATCH)
 *  5. EXTENDED BUT STRONG — overbought but hist still expanding (WATCH)
 *  6. REVERSAL WARNING   — RSI > 75 + hist collapsing (WATCH)
 *  7. SELL               — RSI overbought + hist negative (confirmed rollover)
 *  8. OVERSOLD BOUNCE    — RSI < 35 + hist positive
 *
 * Falls back to Phase 1 logic if ema20 is null.
 * Requires prevHist / prevRsi / prevEma20 from taapi.ts for Phase 2+ conditions.
 */
function momentumScout(
  indicators: Map<string, IndicatorValues>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  for (const sym of symbols) {
    const ind = indicators.get(sym);
    if (!ind) continue;

    const rsi   = ind.rsi;
    const macd  = ind.macd;
    const ema20 = ind.ema20;

    if (rsi === null || macd === null) continue;

    const hist    = macd.valueMACDHist;
    const macdVal = macd.valueMACD;
    const sigVal  = macd.valueMACDSignal;

    // ── Phase 2: prev-bar values (null-safe) ──────────────────────────────
    const prevRsi   = ind.prevRsi   ?? null;
    const prevHist  = ind.prevHist  ?? null;
    const prevEma20 = ind.prevEma20 ?? null;
    const curClose  = ind.currentClose ?? null;

    // ── Phase 3: derived context ───────────────────────────────────────────
    const ema20Slope    = ema20 != null && prevEma20 != null ? ema20 - prevEma20 : null;
    const ema20PctDist  = ema20 != null && curClose  != null && ema20 > 0
      ? ((curClose - ema20) / ema20) * 100
      : null;
    const histChange    = prevHist != null ? hist - prevHist : null;
    const rsiChange     = prevRsi  != null ? rsi  - prevRsi  : null;

    // Build context object — only include fields we actually have
    const context: Signal["context"] = {
      ...(ema20PctDist != null ? { ema20PctDistance: +ema20PctDist.toFixed(2) } : {}),
      ...(ema20Slope   != null ? { ema20Slope:       +ema20Slope.toFixed(4)   } : {}),
      ...(histChange   != null ? { histChange:        +histChange.toFixed(6)   } : {}),
      ...(rsiChange    != null ? { rsiChange:         +rsiChange.toFixed(2)    } : {}),
    };

    // ── Helper: is price above EMA20? ─────────────────────────────────────
    // Strictly requires both currentClose and ema20 — no proxy fallback.
    // MACD polarity is related but not interchangeable with price structure:
    // price can be below EMA20 with MACD still positive, and vice versa.
    // Conditions that need real price structure must check priceAboveEma === true.
    const priceAboveEma: boolean | null =
      ema20 != null && curClose != null ? curClose > ema20 : null;

    if (ema20 !== null) {
      // Renamed from macdBullishCrossover — this describes current bullish alignment
      // (MACD above signal + histogram positive), NOT the crossover event itself.
      // A true crossover requires prevMacd <= prevSignal AND macdVal > sigVal.
      // Until prevMacd/prevSignal are available in taapi.ts, "alignment" is accurate.
      const macdBullishAlignment = hist > 0 && macdVal > sigVal;

      // ── 1. MOMENTUM ACCELERATION (Phase 2 — highest-priority BUY) ──────
      // All five conditions must align:
      //   close > EMA20         — price structure intact
      //   EMA20 slope > 0       — moving average itself rising
      //   hist > 0              — MACD momentum positive
      //   hist > prevHist       — histogram expanding bar-over-bar
      //   RSI > prevRSI         — RSI accelerating upward
      //   RSI 55–75             — momentum zone, not yet overbought
      if (
        priceAboveEma &&
        ema20Slope != null && ema20Slope > 0 &&
        hist > 0 &&
        histChange != null && histChange > 0 &&
        rsiChange  != null && rsiChange  > 0 &&
        rsi >= 55 && rsi <= 75
      ) {
        const prevHistStr = prevHist != null ? prevHist.toFixed(4) : "?";
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "buy",
          reason: `Momentum acceleration — price above rising EMA20 ($${ema20.toFixed(2)}), ` +
                  `histogram expanding (${prevHistStr} → ${hist.toFixed(4)}), ` +
                  `RSI climbing (${prevRsi != null ? prevRsi.toFixed(1) : "?"} → ${rsi.toFixed(1)})`,
          confidence: rsi >= 62 ? "high" : "medium",
          tags: ["acceleration", "trend_continuation"],
          context,
        });
        continue; // Highest priority — skip all lower conditions
      }

      // ── 2. TREND CONTINUATION ──────────────────────────────────────────
      // Tightened: requires real price structure, not just MACD alignment.
      //   priceAboveEma === true  — confirmed by actual close, not proxy
      //   ema20Slope > 0          — EMA20 itself rising (trend has structure)
      //   macdBullishAlignment    — MACD above signal, hist positive
      //   RSI 50–70               — healthy momentum zone
      // Without price + slope confirmation, this would fire in weaker contexts
      // than acceleration, making the two labels inconsistent in quality.
      if (
        priceAboveEma === true &&
        ema20Slope != null && ema20Slope > 0 &&
        macdBullishAlignment &&
        rsi >= 50 && rsi <= 70
      ) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "buy",
          reason: `Trend continuation — price above rising EMA20 ($${ema20.toFixed(2)}), ` +
                  `MACD bullish alignment, RSI ${rsi.toFixed(1)} in momentum zone` +
                  (ema20PctDist != null ? ` (${ema20PctDist.toFixed(1)}% above EMA20)` : ""),
          confidence: rsi >= 55 ? "high" : "medium",
          tags: ["trend_continuation"],
          context,
        });
        continue;
      }

      // ── 3. PULLBACK TO SUPPORT ─────────────────────────────────────────
      // RSI 40–50 + hist still positive — healthy dip toward EMA20
      else if (rsi >= 40 && rsi < 50 && hist > 0) {
        const nearEma = ema20PctDist == null || (ema20PctDist >= -2 && ema20PctDist <= 4);
        if (nearEma) {
          signals.push({
            symbol: sym, agent: "Momentum Scout", type: "buy",
            reason: `Pullback to support — RSI ${rsi.toFixed(1)} dipped to 40–50, MACD hist positive, ` +
                    `near EMA20 ($${ema20.toFixed(2)})` +
                    (ema20PctDist != null ? ` — ${ema20PctDist.toFixed(1)}% from EMA20` : ""),
            confidence: "medium",
            tags: ["pullback_to_support"],
            context,
          });
          continue;
        }
      }

      // ── 4. MOMENTUM DECELERATION (Phase 2) ────────────────────────────
      // hist > 0 but shrinking + RSI > 70 — momentum losing steam above EMA20
      // Fires BEFORE reversal warning so it catches the early signal
      if (
        priceAboveEma &&
        hist > 0 &&
        histChange != null && histChange < 0 &&
        rsi > 70
      ) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `Momentum decelerating — histogram shrinking (${prevHist != null ? prevHist.toFixed(4) : "?"} → ${hist.toFixed(4)}), ` +
                  `RSI overbought at ${rsi.toFixed(1)}, still above EMA20 ($${ema20.toFixed(2)}) — watch for rollover`,
          confidence: rsi > 78 ? "high" : "medium",
          tags: ["decelerating"],
          context,
        });
        continue;
      }

      // ── 5. EXTENDED BUT STRONG ─────────────────────────────────────────
      // RSI 70–78 but histogram still expanding — overbought, don't fight it yet
      if (
        rsi >= 70 && rsi <= 78 &&
        hist > 0 &&
        histChange != null && histChange > 0 &&
        (ema20PctDist == null || ema20PctDist > 4)
      ) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `Extended but strong — RSI ${rsi.toFixed(1)} overbought but histogram still expanding, ` +
                  `price ${ema20PctDist != null ? ema20PctDist.toFixed(1) + "%" : "well"} above EMA20 ($${ema20.toFixed(2)}) — don't fight trend yet`,
          confidence: "medium",
          tags: ["extended_but_strong"],
          context,
        });
        continue;
      }

      // ── 6. REVERSAL WARNING ────────────────────────────────────────────
      // RSI > 75 + histogram small relative to MACD line spread
      else if (rsi > 75 && hist < Math.abs(macdVal) * 0.15) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `Reversal warning — RSI ${rsi.toFixed(1)}, MACD histogram contracting sharply above EMA20 ($${ema20.toFixed(2)})`,
          confidence: rsi > 80 ? "high" : "medium",
          tags: ["rollover"],
          context,
        });
        continue;
      }

      // ── 7. SELL — MOMENTUM ROLLED OVER ────────────────────────────────
      // RSI overbought + hist already negative = confirmed rollover
      else if (rsi > 70 && hist < 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "sell",
          reason: `Momentum rolled over — RSI overbought (${rsi.toFixed(1)}) + MACD hist negative` +
                  (ema20PctDist != null ? `, price ${ema20PctDist.toFixed(1)}% from EMA20 ($${ema20.toFixed(2)})` : ` below EMA20 ($${ema20.toFixed(2)})`),
          confidence: rsi > 80 ? "high" : "medium",
          tags: ["rollover"],
          context,
        });
        continue;
      }

      // ── 8. OVERSOLD BOUNCE (EMA20 context) ───────────────────────────
      else if (rsi < 35 && hist > 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "buy",
          reason: `Oversold bounce — RSI ${rsi.toFixed(1)}, MACD hist positive` +
                  (ema20PctDist != null ? `, price ${ema20PctDist.toFixed(1)}% from EMA20 ($${ema20.toFixed(2)})` : `, EMA20: $${ema20.toFixed(2)}`),
          confidence: rsi < 30 ? "high" : "medium",
          tags: ["oversold_bounce"],
          context,
        });
        continue;
      }

    } else {
      // ── Fallback: ema20 not available — Phase 1 logic ─────────────────
      const macdBullishAlignment = hist > 0 && macdVal > sigVal;

      if (rsi < 35 && hist > 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "buy",
          reason: `RSI oversold (${rsi.toFixed(1)}) + MACD hist positive`,
          confidence: rsi < 30 ? "high" : "medium",
          tags: ["oversold_bounce"],
        });
      } else if (rsi > 70 && hist < 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "sell",
          reason: `RSI overbought (${rsi.toFixed(1)}) + MACD hist negative — momentum fading`,
          confidence: rsi > 80 ? "high" : "medium",
          tags: ["rollover"],
        });
      } else if (rsi > 70 && hist > 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `RSI overbought (${rsi.toFixed(1)}) but MACD hist positive — monitor for reversal`,
          confidence: "medium",
          tags: ["extended_but_strong"],
        });
      } else if (macdBullishAlignment && rsi >= 50 && rsi <= 70) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `MACD bullish alignment — RSI ${rsi.toFixed(1)} in momentum zone (no EMA20 data)`,
          confidence: "low",
          tags: ["trend_continuation"],
        });
      }
    }
  }

  return signals;
}

/**
 * A2 — Breakout Watcher
 * Covers ALL symbols. Requires BB indicator enabled.
 */
function breakoutWatcher(
  indicators: Map<string, IndicatorValues>,
  quotes: Map<string, { price: number }>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  for (const sym of symbols) {
    const ind   = indicators.get(sym);
    const quote = quotes.get(sym);
    if (!ind || !quote || !ind.bb) continue;

    const price = quote.price;
    const { valueLowerBand, valueUpperBand } = ind.bb;
    const bandWidth = valueUpperBand - valueLowerBand;

    if (price > valueUpperBand) {
      signals.push({
        symbol: sym, agent: "Breakout Watcher", type: "buy",
        reason: `Price $${price.toFixed(2)} broke above BB upper ($${valueUpperBand.toFixed(2)})`,
        confidence: "high",
      });
    } else if (price > valueUpperBand - bandWidth * 0.01) {
      signals.push({
        symbol: sym, agent: "Breakout Watcher", type: "watch",
        reason: `Price approaching BB upper — potential breakout setup`,
        confidence: "medium",
      });
    } else if (price < valueLowerBand) {
      signals.push({
        symbol: sym, agent: "Breakout Watcher", type: "watch",
        reason: `Price below BB lower — mean reversion candidate`,
        confidence: "low",
      });
    }
  }

  return signals;
}

/**
 * A3 — Trend Follower
 * Stocks only — EMA 50/200 golden/death cross.
 */
function trendFollower(
  indicators: Map<string, IndicatorValues>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  for (const sym of symbols) {
    const ind = indicators.get(sym);
    if (!ind || ind.ema50 === null || ind.ema200 === null) continue;

    const gap = ((ind.ema50 - ind.ema200) / ind.ema200) * 100;

    if (ind.ema50 > ind.ema200) {
      signals.push({
        symbol: sym, agent: "Trend Follower", type: gap > 2 ? "buy" : "watch",
        reason: `EMA50 ($${ind.ema50.toFixed(2)}) above EMA200 ($${ind.ema200.toFixed(2)}) — bullish trend`,
        confidence: gap > 5 ? "high" : gap > 2 ? "medium" : "low",
      });
    } else {
      signals.push({
        symbol: sym, agent: "Trend Follower", type: "sell",
        reason: `EMA50 below EMA200 — death cross zone`,
        confidence: Math.abs(gap) > 3 ? "high" : "medium",
      });
    }
  }

  return signals;
}

/**
 * A4 — Mean Reversion
 * Covers ALL symbols. Requires RSI < 30 (stricter than Momentum Scout).
 */
function meanReversion(
  indicators: Map<string, IndicatorValues>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  for (const sym of symbols) {
    const ind = indicators.get(sym);
    if (!ind || ind.rsi === null) continue;

    if (ind.rsi < 30) {
      signals.push({
        symbol: sym, agent: "Mean Reversion", type: "buy",
        reason: `RSI deeply oversold at ${ind.rsi.toFixed(1)} — bounce candidate`,
        confidence: ind.rsi < 20 ? "high" : "medium",
      });
    }
  }

  return signals;
}

/**
 * A5 — Volatility Arbiter
 * Covers ALL symbols. ATR spike relative to cross-asset average.
 */
function volatilityArbiter(
  indicators: Map<string, IndicatorValues>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  const atrs = symbols
    .map((s) => indicators.get(s)?.atr)
    .filter((v): v is number => v !== null && v !== undefined);

  if (!atrs.length) return signals;

  const avgAtr = atrs.reduce((a, b) => a + b, 0) / atrs.length;

  for (const sym of symbols) {
    const ind = indicators.get(sym);
    if (!ind || ind.atr === null) continue;

    if (ind.atr > avgAtr * 1.5) {
      signals.push({
        symbol: sym, agent: "Volatility Arbiter", type: "watch",
        reason: `ATR ${ind.atr.toFixed(2)} is ${((ind.atr / avgAtr - 1) * 100).toFixed(0)}% above average — elevated volatility`,
        confidence: ind.atr > avgAtr * 2 ? "high" : "medium",
      });
    }
  }

  return signals;
}

// ─── Activity log generator ────────────────────────────────────────────────

export interface LiveActivityEntry {
  time:    string;
  type:    "signal" | "scan" | "alert";
  agent:   string;
  message: string;
}

function timeAgo(offsetSeconds: number): string {
  if (offsetSeconds === 0) return "now";
  if (offsetSeconds < 60)  return `${offsetSeconds}s`;
  return `${Math.floor(offsetSeconds / 60)}m`;
}

function highlight(sym: string): string {
  return `<span style='color:var(--color-accent-green);font-weight:600'>${sym}</span>`;
}

export function buildActivityLog(agentResults: AgentResult[]): LiveActivityEntry[] {
  const entries: LiveActivityEntry[] = [];
  let offset = 0;

  for (const agent of agentResults) {
    const actionSignals  = agent.signals.filter((s) => s.type === "buy" || s.type === "sell");
    const scannedSymbols = [...new Set(agent.signals.map((s) => s.symbol))];

    entries.push({
      time:    timeAgo(offset),
      type:    "scan",
      agent:   agent.name,
      message: scannedSymbols.length
        ? `Completed scan of ${scannedSymbols.map(highlight).join(" ")} — ${agent.signalCount} signal${agent.signalCount !== 1 ? "s" : ""} found.`
        : `Scan complete — no qualifying setups found.`,
    });
    offset += 15;

    for (const sig of actionSignals.slice(0, 2)) {
      entries.push({
        time:    timeAgo(offset),
        type:    sig.type === "buy" ? "signal" : "alert",
        agent:   agent.name,
        message: `${highlight(sig.symbol)} — ${sig.reason}.`,
      });
      offset += 10;
    }
  }

  return entries.slice(0, 12);
}

// ─── Main evaluation function ──────────────────────────────────────────────

export function evaluateSignals(
  indicators: Map<string, IndicatorValues>,
  quotes: Map<string, { price: number }>,
  stockSymbols: string[],
  cryptoSymbols: string[]
): { agentResults: AgentResult[]; stats: DashboardStats; activity: LiveActivityEntry[] } {
  const allSymbols = [...stockSymbols, ...cryptoSymbols];

  const a1Signals = momentumScout(indicators, allSymbols);
  const a2Signals = breakoutWatcher(indicators, quotes, allSymbols);
  const a3Signals = trendFollower(indicators, stockSymbols);
  const a4Signals = meanReversion(indicators, allSymbols);
  const a5Signals = volatilityArbiter(indicators, allSymbols);

  const agentResults: AgentResult[] = [
    {
      id: "A1", name: "Momentum Scout",
      signalCount: a1Signals.length,
      alertCount:  a1Signals.filter((s) => s.confidence === "high").length,
      lastAction:  a1Signals.length
        ? `Flagged ${a1Signals[0].symbol} — ${a1Signals[0].reason.slice(0, 40)}…`
        : "Scanning — no signals",
      signals: a1Signals,
    },
    {
      id: "A2", name: "Breakout Watcher",
      signalCount: a2Signals.length,
      alertCount:  a2Signals.filter((s) => s.type === "buy").length,
      lastAction:  a2Signals.length
        ? `${a2Signals[0].symbol} breakout setup detected`
        : "Monitoring BB levels",
      signals: a2Signals,
    },
    {
      id: "A3", name: "Trend Follower",
      signalCount: a3Signals.length,
      alertCount:  a3Signals.filter((s) => s.confidence === "high").length,
      lastAction:  a3Signals.length
        ? `${a3Signals[0].symbol} — ${a3Signals[0].reason.slice(0, 40)}…`
        : "Monitoring MA trends",
      signals: a3Signals,
    },
    {
      id: "A4", name: "Mean Reversion",
      signalCount: a4Signals.length,
      alertCount:  a4Signals.filter((s) => s.confidence === "high").length,
      lastAction:  a4Signals.length
        ? `${a4Signals[0].symbol} deeply oversold — bounce watch`
        : "Idle — no setups",
      signals: a4Signals,
    },
    {
      id: "A5", name: "Volatility Arbiter",
      signalCount: a5Signals.length,
      alertCount:  a5Signals.filter((s) => s.confidence === "high").length,
      lastAction:  a5Signals.length
        ? `${a5Signals[0].symbol} vol spike detected`
        : "Waiting for vol spike",
      signals: a5Signals,
    },
  ];

  const allSignals   = agentResults.flatMap((a) => a.signals);
  const buySignals   = allSignals.filter((s) => s.type === "buy");
  const highConf     = buySignals.filter((s) => s.confidence === "high");
  const activeAgents = agentResults.filter((a) => a.signalCount > 0).length;

  const stats: DashboardStats = {
    activeAgents,
    alertsToday:    allSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };

  const activity = buildActivityLog(agentResults);

  return { agentResults, stats, activity };
}
