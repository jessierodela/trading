import type { Agent } from "@/types/agent";

/**
 * config/agents.ts
 * Static agent definitions used by AgentGrid.
 * signalCount / alertCount / lastAction are placeholder defaults —
 * AgentGrid should override these with live data from /api/signals.
 *
 * Crypto Ranger removed — it was an alias of Momentum Scout with no
 * distinct logic. Momentum Scout now covers both stocks and crypto.
 */

export const AGENTS: Agent[] = [
  {
    id:          "A1",
    name:        "Momentum Scout",
    status:      "active",
    focus:       "RSI + MACD — stocks & crypto",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Scanning all symbols…",
  },
  {
    id:          "A2",
    name:        "Breakout Watcher",
    status:      "scanning",
    focus:       "Bollinger Band breakouts",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Monitoring BB levels",
  },
  {
    id:          "A3",
    name:        "Trend Follower",
    status:      "active",
    focus:       "EMA 50/200 golden cross — stocks",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Monitoring MA trends",
  },
  {
    id:          "A4",
    name:        "Mean Reversion",
    status:      "idle",
    focus:       "Deep RSI oversold bounce",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Idle — no setups",
  },
  {
    id:          "A5",
    name:        "Volatility Arbiter",
    status:      "idle",
    focus:       "ATR spike detection",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Waiting for vol spike",
  },
];
