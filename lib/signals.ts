/**
 * lib/signals.ts
 * Converts raw Taapi indicator values → agent signals, activity log entries,
 * and StatsBar counts. This is the "brain" that each agent uses.
 *
 * Agents:
 *  A1 — Momentum Scout:    RSI + MACD — ALL symbols (stocks + crypto)
 *  A2 — Breakout Watcher:  Bollinger Band breakouts — ALL symbols
 *  A3 — Trend Follower:    EMA 50/200 cross — stocks only (needs ema50/ema200)
 *  A4 — Mean Reversion:    Deep RSI oversold — ALL symbols
 *  A5 — Volatility Arbiter: ATR spike — ALL symbols
 *
 * Crypto Ranger removed — it was an alias of Momentum Scout with no
 * distinct logic. Momentum Scout now covers both stocks and crypto.
 */

import type { IndicatorValues } from "./taapi";

export type SignalType = "buy" | "sell" | "watch" | "none";

export interface Signal {
  symbol:     string;
  agent:      string;
  type:       SignalType;
  reason:     string;
  confidence: "high" | "medium" | "low";
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
 * Logic: RSI oversold/overbought + MACD histogram direction.
 */
function momentumScout(
  indicators: Map<string, IndicatorValues>,
  symbols: string[]
): Signal[] {
  const signals: Signal[] = [];

  for (const sym of symbols) {
    const ind = indicators.get(sym);
    if (!ind) continue;

    const rsi  = ind.rsi;
    const macd = ind.macd;

    if (rsi !== null && macd !== null) {
      // RSI oversold bounce + MACD histogram confirming
      if (rsi < 35 && macd.valueMACDHist > 0) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "buy",
          reason: `RSI oversold (${rsi.toFixed(1)}) + MACD hist positive`,
          confidence: rsi < 30 ? "high" : "medium",
        });
      }
      // RSI overbought warning
      else if (rsi > 70) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "sell",
          reason: `RSI overbought (${rsi.toFixed(1)})`,
          confidence: rsi > 80 ? "high" : "medium",
        });
      }
      // MACD bullish crossover only (no RSI extreme)
      else if (macd.valueMACDHist > 0 && macd.valueMACD > macd.valueMACDSignal) {
        signals.push({
          symbol: sym, agent: "Momentum Scout", type: "watch",
          reason: `MACD bullish crossover`,
          confidence: "low",
        });
      }
    }
  }

  return signals;
}

/**
 * A2 — Breakout Watcher
 * Covers ALL symbols. Requires BB indicator enabled.
 * Logic: price relative to Bollinger Band upper/lower.
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
 * Stocks only — EMA 50/200 are most meaningful on equities.
 * Logic: golden cross (ema50 > ema200) vs death cross.
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
 * Covers ALL symbols. Requires RSI.
 * Logic: deeply oversold RSI only (stricter than Momentum Scout's <35 threshold).
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
 * Covers ALL symbols. Requires ATR.
 * Logic: ATR spike relative to average across all scanned symbols.
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

  // A1: Momentum Scout — ALL symbols (was stocks-only before, crypto was duplicated via Crypto Ranger)
  const a1Signals = momentumScout(indicators, allSymbols);
  const a2Signals = breakoutWatcher(indicators, quotes, allSymbols);
  // A3: Trend Follower — stocks only (EMA 50/200 less useful for crypto on daily)
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
