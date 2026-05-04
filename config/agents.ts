import type { Agent } from "@/types/agent";

/**
 * config/agents.ts
 *
 * Static agent definitions used by AgentGrid.
 * signalCount / alertCount / lastAction are placeholder defaults —
 * AgentGrid overrides these with live data from /api/signals.
 *
 * CHANGE LOG:
 *  - IDs corrected to A1–A5 matching route.ts AgentResult records.
 *  - focus strings updated to reflect each agent's actual indicators and role.
 *  - status values set to reflect real runtime behavior.
 *  - lastAction defaults updated to match each agent's scanning behavior.
 *  - A6 — Regime Detector added. Multi-timeframe regime classifier.
 *    Consumes 1H + 1D indicator data. Emits regime label + reliability score.
 *    Runs before all other agents — gates signal quality downstream.
 */

export const AGENTS: Agent[] = [
  {
    id:          "A1",
    name:        "Momentum Scout",
    status:      "active",
    focus:       "1H structure, momentum, volume, and ATR context",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Scanning all symbols…",
  },
  {
    id:          "A2",
    name:        "Breakout Watcher",
    status:      "active",
    focus:       "Bollinger Band breakout and squeeze analysis (1H)",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Monitoring BB levels…",
  },
  {
    id:          "A3",
    name:        "Trend Follower",
    status:      "active",
    focus:       "1D structural bias via EMA50 / EMA200",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Evaluating daily trend structure…",
  },
  {
    id:          "A4",
    name:        "Volatility Arbiter",
    status:      "active",
    focus:       "ATR-based move quality and chase risk (1H)",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Assessing volatility conditions…",
  },
  {
    id:          "A5",
    name:        "Mean Reversion",
    status:      "scanning",
    focus:       "Short-horizon oversold bounce context (1H)",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Scanning for oversold conditions…",
  },
  {
    id:          "A6",
    name:        "Regime Detector",
    status:      "active",
    focus:       "Multi-timeframe regime classification: TREND_UP · TREND_DOWN · LOW_VOL · HIGH_VOL · CHOP · NEWS_SHOCK",
    signalCount: 0,
    alertCount:  0,
    lastAction:  "Classifying market regime (1H + 1D)…",
  },
];
