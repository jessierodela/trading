/**
 * app/api/indicator-config/route.ts
 *
 * GET  → returns current indicator config (file-based persistence)
 * POST → saves new indicator config
 *
 * Config is stored in /tmp/indicator-config.json on the server.
 * For production, swap this out for a DB call (e.g. Vercel KV or Postgres).
 */

import { NextResponse } from "next/server";
import { writeFile, readFile } from "fs/promises";
import { DEFAULT_INDICATOR_CONFIG } from "@/config/indicators";
import type { AssetIndicatorConfig } from "@/config/indicators";

const CONFIG_PATH = "/tmp/indicator-config.json";

async function loadConfig(): Promise<AssetIndicatorConfig[]> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as AssetIndicatorConfig[];
  } catch {
    return DEFAULT_INDICATOR_CONFIG;
  }
}

export async function GET() {
  const config = await loadConfig();
  return NextResponse.json({ config });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (!Array.isArray(body.config)) {
      return NextResponse.json({ error: "Invalid config format" }, { status: 400 });
    }

    const config = body.config as AssetIndicatorConfig[];

    // Basic validation — each entry must have symbol + enabled array
    for (const entry of config) {
      if (typeof entry.symbol !== "string" || !Array.isArray(entry.enabled)) {
        return NextResponse.json({ error: "Malformed config entry" }, { status: 400 });
      }
    }

    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    console.error("[indicator-config] save error:", err);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}