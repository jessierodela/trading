/**
 * lib/telegram.ts
 * Telegram Bot API helpers — send messages, format trading signals
 */

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ─── Core send ────────────────────────────────────────────────────────────────

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

// ─── Signal formatting ────────────────────────────────────────────────────────

export interface TelegramSignalPayload {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL" | string;
  confidence: "high" | "medium" | "low" | string;
  score: number;
  maxScore: number;
  summary: string;
  agents: Array<{
    name: string;
    signal: string;
    confidence: string;
    reasoning?: string;
  }>;
  fetchedAt?: string;
}

const DIRECTION_EMOJI: Record<string, string> = {
  LONG: "🟢",
  SHORT: "🔴",
  NEUTRAL: "⚪",
};

const CONFIDENCE_EMOJI: Record<string, string> = {
  high: "🔥",
  medium: "📊",
  low: "❄️",
};

const AGENT_EMOJI: Record<string, string> = {
  "Momentum Scout": "⚡",
  "Breakout Watcher": "💥",
  "Trend Follower": "📈",
  "Volatility Arbiter": "🌪️",
  "Mean Reversion": "↩️",
};

export function formatSignalMessage(payload: TelegramSignalPayload): string {
  const dirEmoji = DIRECTION_EMOJI[payload.direction] ?? "⚪";
  const confEmoji = CONFIDENCE_EMOJI[payload.confidence] ?? "📊";
  const scoreBar = buildScoreBar(payload.score, -8, 8);
  const scoreLabel = `${payload.score > 0 ? "+" : ""}${payload.score}/8`;
  const time = payload.fetchedAt
    ? new Date(payload.fetchedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Chicago",
      })
    : "—";

  const agentLines = payload.agents
    .map((a) => {
      const emoji = AGENT_EMOJI[a.name] ?? "🤖";
      const sig = a.signal?.toUpperCase() ?? "—";
      const conf = a.confidence ? ` (${a.confidence})` : "";
      return `  ${emoji} <b>${a.name}</b>: ${sig}${conf}`;
    })
    .join("\n");

  return [
    `<b>🔭 ${payload.symbol} Signal</b>  <i>${time} CT</i>`,
    ``,
    `${dirEmoji} <b>${payload.direction}</b>  ${confEmoji} ${payload.confidence.toUpperCase()}`,
    `${scoreBar}  <code>${scoreLabel}</code>`,
    ``,
    `<b>Agents:</b>`,
    agentLines,
    ``,
    `<b>📝 Summary:</b>`,
    payload.summary,
  ].join("\n");
}

export function formatRefreshStartMessage(symbol: string): string {
  return `⏳ Refreshing <b>${symbol}</b> data...\nThis takes ~75s on the free plan. I'll ping you when it's done.`;
}

export function formatErrorMessage(symbol: string, error: string): string {
  return `❌ <b>${symbol}</b> refresh failed:\n<code>${error}</code>`;
}

export function formatStatusMessage(cachedSymbols: string[]): string {
  if (!cachedSymbols.length) {
    return "📭 No cached signals yet. Use /refresh BTC to fetch fresh data.";
  }
  const list = cachedSymbols.map((s) => `  • ${s}`).join("\n");
  return `📦 <b>Cached signals:</b>\n${list}\n\nUse /signals BTC to view latest.`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Score range is -8 to +8. Bar shows position within that full range.
function buildScoreBar(score: number, min: number, max: number): string {
  const normalized = (score - min) / (max - min); // 0.0–1.0
  const filled = Math.min(8, Math.max(0, Math.round(normalized * 8)));
  return "█".repeat(filled) + "░".repeat(8 - filled);
}
