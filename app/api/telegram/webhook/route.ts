/**
 * app/api/telegram/webhook/route.ts
 *
 * Receives Telegram bot updates and dispatches trading commands.
 *
 * Supported commands:
 *   /refresh [symbol] - queues a refresh job and replies with job status
 *   /signals [symbol] - returns latest cached signals
 *   /status           - lists symbols with cached data
 *   /help             - lists available commands
 */

import { NextRequest, NextResponse } from "next/server";
import {
  sendMessage,
  formatSignalMessage,
  formatErrorMessage,
  formatStatusMessage,
  type TelegramSignalPayload,
} from "@/lib/telegram";
import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  buildTelegramRefreshJob,
  displayRefreshSymbol,
  enqueueJobForRoute,
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";

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

interface ConfluenceResult {
  symbol: string;
  verdict: string;
  weightedScore: number;
  narrative: string;
  tags: string[];
  agentVotes: Array<{ agent: string; signal: string; confidence: string; score: number }>;
  gateMet: boolean;
  hasHardConflict: boolean;
}

function isAllowedChat(chatId: number): boolean {
  const allowed = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "";
  if (!allowed) return true;
  return allowed.split(",").map((id) => id.trim()).includes(String(chatId));
}

function parseCommand(text: string): { command: string; args: string[] } {
  const parts = text.trim().split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase().replace(/^\//, "").split("@")[0];
  const args = parts.slice(1);
  return { command, args };
}

function resolveSignalSymbol(args: string[]): string {
  const raw = (args[0] ?? "BTC").toUpperCase();
  if (raw.includes("/")) return raw;
  const map: Record<string, string> = {
    BTC: "BTC/USDT",
    ETH: "ETH/USDT",
    SOL: "SOL/USDT",
    BNB: "BNB/USDT",
    XRP: "XRP/USDT",
  };
  return map[raw] ?? raw;
}

async function handleRefresh(chatId: number, symbolArg: string | undefined): Promise<void> {
  const displaySymbol = displayRefreshSymbol(symbolArg ?? "BTC");

  try {
    if (!hasRouteDatabaseUrl()) {
      await sendMessage(chatId, formatErrorMessage(displaySymbol, routeDatabaseUnavailableError()));
      return;
    }

    const store = new PostgresJobStore(getPgPool());
    const built = buildTelegramRefreshJob({ symbol: symbolArg });
    const { job, deduped } = await enqueueJobForRoute(store, built.payload, {
      dedupeKey: built.dedupeKey,
    });

    await sendMessage(
      chatId,
      [
        `Refresh queued for <b>${displaySymbol}</b>.`,
        `Job: <code>${job.publicId}</code>`,
        `Status: <code>${job.status}</code>`,
        ...(deduped ? ["Existing active refresh reused."] : []),
      ].join("\n"),
    );
  } catch (err) {
    await sendMessage(chatId, formatErrorMessage(displaySymbol, String(err)));
  }
}

async function handleSignals(chatId: number, symbol: string, baseUrl: string): Promise<void> {
  try {
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
        `No cached signals for <b>${symbol}</b>.\nUse /refresh ${symbol.split("/")[0]} to queue fresh data.`,
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
    const known = ["BTC/USDT", "ETH/USDT"];
    const cached: string[] = [];

    for (const sym of known) {
      try {
        const res = await fetch(`${baseUrl}/api/signals?symbol=${encodeURIComponent(sym)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.confluence) && data.confluence.length > 0) cached.push(sym);
        }
      } catch {
        // Keep status best-effort.
      }
    }

    await sendMessage(chatId, formatStatusMessage(cached));
  } catch (err) {
    await sendMessage(chatId, formatErrorMessage("status", String(err)));
  }
}

async function handleHelp(chatId: number): Promise<void> {
  const msg = [
    "<b>Trading Dashboard Bot</b>",
    "",
    "<b>Commands:</b>",
    "  /refresh [symbol] - Queue fresh dashboard data",
    "  /signals [symbol] - View latest cached signals",
    "  /status           - List symbols with cached data",
    "  /help             - Show this message",
    "",
    "<b>Examples:</b>",
    "  <code>/refresh btc</code>",
    "  <code>/signals eth</code>",
    "  <code>/refresh BTC</code>",
    "",
    "Supported symbols: BTC, ETH",
  ].join("\n");

  await sendMessage(chatId, msg);
}

function extractSignalPayload(data: unknown, symbol: string): TelegramSignalPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const confluenceArr = d.confluence as ConfluenceResult[] | undefined;

  if (Array.isArray(confluenceArr) && confluenceArr.length > 0) {
    const entry =
      confluenceArr.find((c) => c.symbol?.toUpperCase() === symbol.toUpperCase()) ??
      confluenceArr[0];
    const maxScore = 8;
    const minScore = -8;
    const rawScore = entry.weightedScore ?? 0;
    const normalized = (rawScore - minScore) / (maxScore - minScore);
    const confidence = normalized >= 0.75 ? "high" : normalized >= 0.5 ? "medium" : "low";

    return {
      symbol: entry.symbol,
      direction: entry.verdict ?? "NEUTRAL",
      confidence,
      score: rawScore,
      maxScore,
      summary: entry.narrative ?? "",
      agents: (entry.agentVotes ?? []).map((v) => ({
        name: v.agent,
        signal: v.signal,
        confidence: v.confidence,
      })),
      fetchedAt: String(d.generatedAt ?? ""),
    };
  }

  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const update: TelegramUpdate = await req.json();
    const message = update.message;

    if (!message?.text) return NextResponse.json({ ok: true });

    const chatId = message.chat.id;
    if (!isAllowedChat(chatId)) {
      console.warn(`[telegram] Unauthorized chat: ${chatId}`);
      return NextResponse.json({ ok: true });
    }

    const { command, args } = parseCommand(message.text);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `https://${req.headers.get("host")}`;

    console.log(`[telegram] Command: /${command} from chat ${chatId}`);

    switch (command) {
      case "refresh":
        await handleRefresh(chatId, args[0]);
        break;
      case "signals":
      case "signal":
        await handleSignals(chatId, resolveSignalSymbol(args), baseUrl);
        break;
      case "status":
        await handleStatus(chatId, baseUrl);
        break;
      case "start":
      case "help":
        await handleHelp(chatId);
        break;
      default:
        await sendMessage(chatId, "Unknown command. Use /help to see available commands.");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telegram] Webhook error:", err);
    return NextResponse.json({ ok: true });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, info: "Telegram webhook - POST only" });
}
