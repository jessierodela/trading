/**
 * app/api/telegram/webhook/route.ts
 *
 * Receives Telegram bot updates and dispatches trading commands.
 *
 * Supported commands:
 *   /refresh [symbol]   — triggers cache refresh + runs pipeline, replies with signals
 *   /signals [symbol]   — returns latest cached signals (no re-fetch)
 *   /status             — lists symbols with cached data
 *   /help               — lists available commands
 *
 * Setup:
 *   1. Create bot via @BotFather → get TELEGRAM_BOT_TOKEN
 *   2. Get your chat ID: send bot a message, hit
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3. Register webhook:
 *      https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram/webhook
 *   4. Add env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS (comma-separated)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  sendMessage,
  formatSignalMessage,
  formatRefreshStartMessage,
  formatErrorMessage,
  formatStatusMessage,
  type TelegramSignalPayload,
} from "@/lib/telegram";

// ─── Telegram update types (minimal subset) ───────────────────────────────────

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function isAllowedChat(chatId: number): boolean {
  const allowed = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "";
  if (!allowed) return true; // open if not configured
  return allowed.split(",").map((id) => id.trim()).includes(String(chatId));
}

// ─── Command parsing ──────────────────────────────────────────────────────────

function parseCommand(text: string): { command: string; args: string[] } {
  const parts = text.trim().split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase().replace(/^\//, "").split("@")[0];
  const args = parts.slice(1);
  return { command, args };
}

function resolveSymbol(args: string[]): string {
  // Normalize: "btc" → "BTC/USDT", "eth" → "ETH/USDT", already-formatted pass through
  const raw = (args[0] ?? "BTC").toUpperCase();
  if (raw.includes("/")) return raw;
  // Common shorthands
  const MAP: Record<string, string> = {
    BTC: "BTC/USDT",
    ETH: "ETH/USDT",
    SOL: "SOL/USDT",
    BNB: "BNB/USDT",
    XRP: "XRP/USDT",
  };
  return MAP[raw] ?? raw;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleRefresh(chatId: number, symbol: string, baseUrl: string): Promise<void> {
  await sendMessage(chatId, formatRefreshStartMessage(symbol));

  try {
    // 1. Trigger cache refresh (POST — this is the correct fetch-initiating route)
    const refreshRes = await fetch(`${baseUrl}/api/cache/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    });

    if (!refreshRes.ok) {
      const err = await refreshRes.text();
      await sendMessage(chatId, formatErrorMessage(symbol, err.slice(0, 200)));
      return;
    }

    // 2. Fetch signals (GET — read-only, returns full cache payload)
    const signalsRes = await fetch(`${baseUrl}/api/signals`);
    if (!signalsRes.ok) {
      await sendMessage(chatId, formatErrorMessage(symbol, "Signals fetch failed after refresh."));
      return;
    }

    const data = await signalsRes.json();
    const payload = extractSignalPayload(data, symbol);

    if (!payload) {
      await sendMessage(chatId, `⚠️ <b>${symbol}</b>: No signal data returned. Try again shortly.`);
      return;
    }

    await sendMessage(chatId, formatSignalMessage(payload));
  } catch (err) {
    await sendMessage(chatId, formatErrorMessage(symbol, String(err)));
  }
}

async function handleSignals(chatId: number, symbol: string, baseUrl: string): Promise<void> {
  try {
    // /api/signals returns the full memCache payload — no symbol filtering at route level.
    // extractSignalPayload handles finding the right confluence entry by symbol.
    const res = await fetch(`${baseUrl}/api/signals`);
    if (!res.ok) {
      await sendMessage(chatId, formatErrorMessage(symbol, "Signals API error."));
      return;
    }
    const data = await res.json();
    const payload = extractSignalPayload(data, symbol);

    if (!payload) {
      await sendMessage(
        chatId,
        `📭 No cached signals for <b>${symbol}</b>.\nUse /refresh ${symbol.split("/")[0]} to fetch fresh data.`
      );
      return;
    }

    await sendMessage(chatId, formatSignalMessage(payload));
  } catch (err) {
    await sendMessage(chatId, formatErrorMessage(symbol, String(err)));
  }
}

async function handleStatus(chatId: number, baseUrl: string): Promise<void> {
  try {
    // Hit the cache status endpoint if you have one, otherwise use signals for known symbols
    const KNOWN = ["BTC/USDT", "ETH/USDT"];
    const cached: string[] = [];

    for (const sym of KNOWN) {
      try {
        const res = await fetch(`${baseUrl}/api/signals?symbol=${encodeURIComponent(sym)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.confluence) && data.confluence.length > 0) cached.push(sym);
        }
      } catch {
        // skip
      }
    }

    await sendMessage(chatId, formatStatusMessage(cached));
  } catch (err) {
    await sendMessage(chatId, formatErrorMessage("status", String(err)));
  }
}

async function handleHelp(chatId: number): Promise<void> {
  const msg = [
    `<b>🤖 Trading Dashboard Bot</b>`,
    ``,
    `<b>Commands:</b>`,
    `  /refresh [symbol] — Fetch fresh data &amp; run agents`,
    `  /signals [symbol] — View latest cached signals`,
    `  /status           — List symbols with cached data`,
    `  /help             — Show this message`,
    ``,
    `<b>Examples:</b>`,
    `  <code>/refresh btc</code>`,
    `  <code>/signals eth</code>`,
    `  <code>/refresh BTC/USDT</code>`,
    ``,
    `Supported symbols: BTC, ETH (free plan)`,
  ].join("\n");

  await sendMessage(chatId, msg);
}

// ─── Signal shape extraction ──────────────────────────────────────────────────
// Matches the exact memCache.response payload written by POST /api/cache/refresh:
//
//   {
//     agentResults: AgentResult[],          // one entry per agent
//     confluence:   ConfluenceResult[],      // one entry per symbol that met the gate
//     stats, activity, generatedAt, indicators, derived
//   }
//
// ConfluenceResult fields used here:
//   symbol, verdict, weightedScore, narrative, tags,
//   agentVotes[]: { agent, signal, confidence, score }
//   gateMet, hasHardConflict
//
// AgentResult signals[]: { type, confidence, ... }
// Weighted score is out of ~13 (gates×3 + contributors×2 + modifier×1).

interface ConfluenceResult {
  symbol:          string;
  verdict:         string;   // "LONG" | "SHORT" | "NEUTRAL"
  weightedScore:   number;
  narrative:       string;
  tags:            string[];
  agentVotes:      Array<{ agent: string; signal: string; confidence: string; score: number }>;
  gateMet:         boolean;
  hasHardConflict: boolean;
}

function extractSignalPayload(data: unknown, symbol: string): TelegramSignalPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // /api/signals returns the full cache payload — confluence is an array, one per symbol.
  const confluenceArr = d.confluence as ConfluenceResult[] | undefined;
  if (Array.isArray(confluenceArr) && confluenceArr.length > 0) {
    // Find the entry for the requested symbol (e.g. "BTC/USDT")
    const entry = confluenceArr.find(
      (c) => c.symbol?.toUpperCase() === symbol.toUpperCase()
    ) ?? confluenceArr[0]; // fall back to first if only one symbol in cache

    // Derive confidence label from score
    const MAX_SCORE = 8;
    const MIN_SCORE = -8;
    const rawScore = entry.weightedScore ?? 0;
    // Normalize [-8, 8] → [0, 1] for display and confidence
    const normalized = (rawScore - MIN_SCORE) / (MAX_SCORE - MIN_SCORE); // 0.0–1.0
    const confidence = normalized >= 0.75 ? "high" : normalized >= 0.5 ? "medium" : "low";

    return {
      symbol:     entry.symbol,
      direction:  entry.verdict ?? "NEUTRAL",
      confidence,
      score:      rawScore,
      maxScore:   MAX_SCORE,
      summary:    entry.narrative ?? "",
      agents:     (entry.agentVotes ?? []).map((v) => ({
        name:       v.agent,
        signal:     v.signal,
        confidence: v.confidence,
      })),
      fetchedAt: String(d.generatedAt ?? ""),
    };
  }

  return null;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const update: TelegramUpdate = await req.json();
    const message = update.message;

    // Only handle text messages
    if (!message?.text) return NextResponse.json({ ok: true });

    const chatId = message.chat.id;

    // Auth guard
    if (!isAllowedChat(chatId)) {
      console.warn(`[telegram] Unauthorized chat: ${chatId}`);
      return NextResponse.json({ ok: true });
    }

    const { command, args } = parseCommand(message.text);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `https://${req.headers.get("host")}`;

    console.log(`[telegram] Command: /${command} from chat ${chatId}`);

    switch (command) {
      case "refresh":
        await handleRefresh(chatId, resolveSymbol(args), baseUrl);
        break;
      case "signals":
      case "signal":
        await handleSignals(chatId, resolveSymbol(args), baseUrl);
        break;
      case "status":
        await handleStatus(chatId, baseUrl);
        break;
      case "start":
      case "help":
        await handleHelp(chatId);
        break;
      default:
        await sendMessage(
          chatId,
          `Unknown command. Use /help to see available commands.`
        );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telegram] Webhook error:", err);
    // Always return 200 to Telegram or it will retry
    return NextResponse.json({ ok: true });
  }
}

// Telegram uses POST only — disable other methods
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, info: "Telegram webhook — POST only" });
}
