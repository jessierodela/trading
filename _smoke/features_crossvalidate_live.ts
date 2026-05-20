/**
 * _smoke/features_crossvalidate_live.ts
 *
 * P2D LIVE cross-validation. `npm run smoke:p2d:live`.
 * Requires TAAPI_API_KEY and DATABASE_URL (loaded from .env.local).
 *
 * What it does:
 *   1. Picks a recent contiguous 72-bar BTC-USD 1h window from market_bars,
 *      with >=200 contiguous warmup bars before it (EMA200 needs ~200).
 *   2. Computes features over the contiguous range via the P2C engine.
 *   3. Fetches TAAPI (Binance BTC/USDT) reference values for the 72 sampled
 *      timestamps — bulk POST, chunked across the free-tier rate limit
 *      (~1 req / 15s), aligned by addResultTimestamp (never positional).
 *   4. Cross-validates (indicator-specific tolerances, hard/soft).
 *   5. Internal volume + Bollinger naive-recompute checks.
 *   6. If UPDATE_P2D_FIXTURE=true → writes the self-contained fixture.
 *      Otherwise compares only; does NOT touch the fixture.
 *   7. Generates P2D_CROSSVALIDATION_REPORT.md with an explicit GO / NO-GO.
 *   8. Exits non-zero on hard failures.
 *
 * Cross-venue note: local is Coinbase BTC-USD, TAAPI free plan is Binance
 * BTC/USDT. TAAPI is an external sanity check, not exact parity.
 *
 * If TAAPI is down / rate-limited / the key is invalid, this STOPS and
 * reports. It never falls back to synthetic data.
 */
import * as fs from "fs";
import * as path from "path";
import { getPgPool, closePgPool, PgBarStore } from "../lib/storage";
import { computeFeaturesSegmented } from "../lib/features/engine";
import { validateBarSeries, findGaps, longestContiguousSuffix } from "../lib/features/gaps";
import {
  crossValidate,
  validateVolumeInternally,
  validateBollingerInternally,
  TOLERANCES,
  type TaapiRefValues,
  type CrossValidationReport,
  type InternalCheckResult,
} from "../lib/features/crossValidate";
import { FEATURE_VERSION } from "../lib/versions";
import type { Bar, FeatureSnapshot, Timeframe } from "../lib/quant/types";
import type { P2DFixture } from "./features_crossvalidate";

// ─── Config ─────────────────────────────────────────────────────────────────

const SYMBOL    = "BTC-USD";
const EXCHANGE  = "COINBASE" as const;
const TIMEFRAME: Timeframe = "1h";

const TAAPI_SYMBOL   = "BTC/USDT";
const TAAPI_EXCHANGE = "binance";
const TAAPI_BASE     = "https://api.taapi.io";

const SAMPLE_BARS = 72;
const WARMUP_BARS = 200;
const HOUR_MS     = 3_600_000;

/** Backtracks fetched per bulk request. 7 constructs × CHUNK calcs per request.
 *  Override with P2D_BACKTRACK_CHUNK if TAAPI's free-tier calc cap rejects. */
const BACKTRACK_CHUNK = Number(process.env.P2D_BACKTRACK_CHUNK ?? 10);
/** Extra backtracks beyond the 72 sample, to absorb venue clock drift. */
const BACKTRACK_BUFFER = 6;
const TAAPI_REQ_DELAY_MS = 15_500; // free plan: ~1 request / 15s

const FIXTURE_DIR  = path.join(__dirname, "..", "fixtures", "p2d");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "btc_1h_crossvalidation_fixture.json");
const REPORT_PATH  = path.join(__dirname, "..", "P2D_CROSSVALIDATION_REPORT.md");

// ─── TAAPI constructs (7 constructs → 11 compared values) ───────────────────

interface TaapiConstruct { id: string; indicator: string; period?: number; }

const TAAPI_CONSTRUCTS: TaapiConstruct[] = [
  { id: "rsi14",  indicator: "rsi" },
  { id: "macd",   indicator: "macd" },
  { id: "ema20",  indicator: "ema", period: 20 },
  { id: "ema50",  indicator: "ema", period: 50 },
  { id: "ema200", indicator: "ema", period: 200 },
  { id: "atr14",  indicator: "atr" },
  { id: "bb",     indicator: "bbands" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function floorHourIso(ms: number): string {
  return new Date(ms - (ms % HOUR_MS)).toISOString();
}

function fail(msg: string): never {
  console.error(`\n[p2d:live] STOP — ${msg}`);
  closePgPool().catch(() => {});
  process.exit(1);
}

// ─── TAAPI historical fetch (self-contained; does not touch lib/taapi.ts) ───

interface TaapiBulkResultItem {
  id:      string;
  result:  Record<string, number> | Record<string, number>[];
  errors?: string[];
}

/**
 * Merge a single TAAPI result object (one candle) into the per-timestamp
 * accumulator, mapping TAAPI's result keys to our field names.
 */
function mergeTaapiResult(
  acc: Map<string, TaapiRefValues>,
  id: string,
  r: Record<string, number>,
): void {
  const tsSec = r.timestamp;
  if (tsSec === undefined || tsSec === null) return;
  const iso = floorHourIso(tsSec * 1000);
  const cur: TaapiRefValues = acc.get(iso) ?? {};
  switch (id) {
    case "rsi14":  cur.rsi14  = r.value; break;
    case "ema20":  cur.ema20  = r.value; break;
    case "ema50":  cur.ema50  = r.value; break;
    case "ema200": cur.ema200 = r.value; break;
    case "atr14":  cur.atr14  = r.value; break;
    case "macd":
      cur.macd       = r.valueMACD;
      cur.macdSignal = r.valueMACDSignal;
      cur.macdHist   = r.valueMACDHist;
      break;
    case "bb":
      cur.bbUpper  = r.valueUpperBand;
      cur.bbMiddle = r.valueMiddleBand;
      cur.bbLower  = r.valueLowerBand;
      break;
  }
  acc.set(iso, cur);
}

async function fetchTaapiChunk(
  key: string,
  offset: number,
  count: number,
): Promise<TaapiBulkResultItem[]> {
  const indicators = TAAPI_CONSTRUCTS.map((c) => {
    const wire: Record<string, unknown> = {
      id: c.id,
      indicator: c.indicator,
      backtrack: offset,
      backtracks: count,
      addResultTimestamp: true,
    };
    if (c.period !== undefined) wire.period = c.period;
    return wire;
  });

  const body = {
    secret: key,
    construct: {
      exchange: TAAPI_EXCHANGE,
      symbol:   TAAPI_SYMBOL,
      interval: "1h",
      indicators,
    },
  };

  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(`${TAAPI_BASE}/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const backoff = (attempt + 1) * TAAPI_REQ_DELAY_MS;
      console.warn(`[p2d:live] rate limited (429), backing off ${backoff / 1000}s…`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      // 4xx that isn't 429 is fatal (bad key, calc cap, bad params).
      fail(`TAAPI bulk request failed: ${res.status} — ${text}`);
    }
    const json = (await res.json()) as { data: TaapiBulkResultItem[] };
    return json.data ?? [];
  }
  fail("TAAPI bulk request kept getting rate limited after retries");
}

async function fetchTaapiReference(
  key: string,
  sampleTimestamps: string[],
): Promise<{ reference: Record<string, TaapiRefValues>; covered: number }> {
  const acc = new Map<string, TaapiRefValues>();
  const totalBacktracks = SAMPLE_BARS + BACKTRACK_BUFFER;
  const chunks = Math.ceil(totalBacktracks / BACKTRACK_CHUNK);

  console.log(
    `[p2d:live] fetching TAAPI: ${TAAPI_CONSTRUCTS.length} constructs × ${BACKTRACK_CHUNK} backtracks/req, ` +
    `${chunks} requests (~${Math.round((chunks * TAAPI_REQ_DELAY_MS) / 1000)}s wall time)`,
  );

  for (let c = 0; c < chunks; c++) {
    const offset = c * BACKTRACK_CHUNK;
    const count  = Math.min(BACKTRACK_CHUNK, totalBacktracks - offset);
    console.log(`[p2d:live]   request ${c + 1}/${chunks}: backtrack ${offset}..${offset + count - 1}`);
    const data = await fetchTaapiChunk(key, offset, count);
    for (const item of data) {
      if (item.errors?.length) {
        console.warn(`[p2d:live]   construct "${item.id}" errors:`, item.errors);
        continue;
      }
      const arr = Array.isArray(item.result) ? item.result : [item.result];
      for (const r of arr) mergeTaapiResult(acc, item.id, r);
    }
    if (c < chunks - 1) await sleep(TAAPI_REQ_DELAY_MS);
  }

  const reference: Record<string, TaapiRefValues> = {};
  let covered = 0;
  for (const ts of sampleTimestamps) {
    if (acc.has(ts)) { reference[ts] = acc.get(ts)!; covered++; }
  }
  return { reference, covered };
}

// ─── Report generation ──────────────────────────────────────────────────────

function buildReport(
  report: CrossValidationReport,
  vol: InternalCheckResult,
  bb: InternalCheckResult,
  capturedAt: string,
  warmupBars: number,
): string {
  const go = report.passed && vol.ok && bb.ok;
  const L: string[] = [];
  L.push("# P2D — Feature Engine Cross-Validation Report");
  L.push("");
  L.push("> P2D proves the local engine is internally deterministic and");
  L.push("> mathematically consistent, then uses TAAPI as an external");
  L.push("> cross-venue sanity check before the live cutover.");
  L.push("");
  L.push("Local is **Coinbase BTC-USD**; TAAPI free plan is **Binance BTC/USDT**.");
  L.push("Different venues — this is a ballpark sanity check, not exact parity.");
  L.push("");
  L.push("## Run metadata");
  L.push("");
  L.push(`- Local feature version: \`${report.featureVersion}\``);
  L.push(`- TAAPI capture timestamp: ${capturedAt}`);
  L.push(`- TAAPI symbol/exchange: ${TAAPI_SYMBOL} @ ${TAAPI_EXCHANGE}`);
  L.push(`- Local symbol/exchange: ${report.symbol} @ ${report.localExchange}`);
  L.push(`- Timeframe: ${report.timeframe}`);
  L.push(`- Sampled bars: ${report.sampledBars}`);
  L.push(`- Warmup bars before sample: ${warmupBars}`);
  L.push(`- Sample range: ${report.sampleStartTs} → ${report.sampleEndTs}`);
  L.push("");
  L.push("## Indicator-level results (TAAPI cross-venue comparison)");
  L.push("");
  L.push("| Indicator | Sampled | Pass | Soft | Hard | Tolerance | Worst |abs diff| @ ts |");
  L.push("|-----------|--------:|-----:|-----:|-----:|-----------|------------------------|");
  for (const s of report.indicatorSummaries) {
    L.push(
      `| ${s.indicator} | ${s.sampledBars} | ${s.passed} | ${s.softFindings} | ` +
      `${s.hardFailures} | ${s.toleranceUsed} | ${s.worstAbsDiff.toPrecision(4)} @ ${s.worstBarTs} |`,
    );
  }
  L.push("");
  L.push("## Hard failures");
  L.push("");
  if (report.hardFailures.length === 0) {
    L.push("None.");
  } else {
    L.push("| ts | indicator | local | reference | abs diff | reason |");
    L.push("|----|-----------|------:|----------:|---------:|--------|");
    for (const d of report.hardFailures) {
      L.push(`| ${d.ts} | ${d.indicator} | ${fmt(d.localValue)} | ${fmt(d.referenceValue)} | ${fmt(d.absDiff ?? null)} | ${d.reason ?? ""} |`);
    }
  }
  L.push("");
  L.push("## Soft findings (cross-venue outliers — documented, non-blocking)");
  L.push("");
  if (report.softFindings.length === 0) {
    L.push("None.");
  } else {
    L.push("| ts | indicator | local | reference | abs diff | reason |");
    L.push("|----|-----------|------:|----------:|---------:|--------|");
    for (const d of report.softFindings) {
      L.push(`| ${d.ts} | ${d.indicator} | ${fmt(d.localValue)} | ${fmt(d.referenceValue)} | ${fmt(d.absDiff ?? null)} | ${d.reason ?? ""} |`);
    }
  }
  L.push("");
  L.push("## Internal validation (recomputed a second, naive way — not TAAPI)");
  L.push("");
  L.push(`- **Volume** (volumeSma20, relativeVolume20): ${vol.ok ? "PASS" : "FAIL"} — ${vol.passed}/${vol.checked} checks. Method: naive sum-of-last-20-non-null-volumes / 20; relativeVolume = volume / that. Volume is venue-specific and is never compared against TAAPI.`);
  if (!vol.ok) for (const f of vol.failures.slice(0, 20)) L.push(`  - ${f.ts} ${f.field}: engine=${fmt(f.engine)} naive=${fmt(f.naive)} — ${f.reason}`);
  L.push(`- **Bollinger** (bbUpper/Middle/Lower): ${bb.ok ? "PASS" : "FAIL"} — ${bb.passed}/${bb.checked} checks. Method: SMA20 ± 2·population stdev over last 20 closes.`);
  if (!bb.ok) for (const f of bb.failures.slice(0, 20)) L.push(`  - ${f.ts} ${f.field}: engine=${fmt(f.engine)} naive=${fmt(f.naive)} — ${f.reason}`);
  L.push("");
  L.push("## Recommendation");
  L.push("");
  if (go) {
    L.push("> **GO** — no hard failures. Soft findings documented above are");
    L.push("> explainable cross-venue differences. The local engine is cleared");
    L.push("> for the live pipeline cutover.");
  } else {
    L.push("> **NO-GO** — hard failures and/or internal-consistency failures");
    L.push("> listed above must be resolved before cutover.");
    L.push(">");
    const reasons: string[] = [];
    if (report.hardFailures.length > 0) reasons.push(`${report.hardFailures.length} hard TAAPI cross-validation failure(s)`);
    if (!vol.ok) reasons.push(`${vol.failures.length} internal volume failure(s)`);
    if (!bb.ok) reasons.push(`${bb.failures.length} internal Bollinger failure(s)`);
    L.push(`> Specifics: ${reasons.join("; ")}.`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("_P2D does NOT perform the live pipeline cutover — that is separately");
  L.push("gated on this report's recommendation._");
  L.push("");
  return L.join("\n");
}

function fmt(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const key = process.env.TAAPI_API_KEY ?? process.env.TAAPI_KEY;
  if (!key) fail("TAAPI_API_KEY (or TAAPI_KEY) is not set (expected in .env.local).");
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    fail("DATABASE_URL or SUPABASE_DB_URL is not set (expected in .env.local).");
  }
  const updateFixture = process.env.UPDATE_P2D_FIXTURE === "true";

  const pool  = getPgPool();
  const store = new PgBarStore(pool);

  // 1. Latest closed 1h bar.
  const latest = await store.latestTs({ symbol: SYMBOL, exchange: EXCHANGE, timeframe: TIMEFRAME });
  if (!latest) fail(`no ${TIMEFRAME} bars for ${SYMBOL}@${EXCHANGE} in market_bars — backfill first.`);
  const sampleEndMs = Date.parse(latest!) - (Date.parse(latest!) % HOUR_MS);

  // 2/3. Fetch a generous range: 72 sample + 200 warmup + slack.
  const slack = 8;
  const fullStartMs = sampleEndMs - (SAMPLE_BARS + WARMUP_BARS + slack) * HOUR_MS;
  const fetchEndMs  = sampleEndMs + HOUR_MS; // exclusive end → include sampleEnd bar
  console.log(`[p2d:live] reading bars ${new Date(fullStartMs).toISOString()} → ${new Date(fetchEndMs).toISOString()}`);
  const rawBars = await store.fetchRange(
    { symbol: SYMBOL, exchange: EXCHANGE, timeframe: TIMEFRAME },
    { startTs: new Date(fullStartMs).toISOString(), endTs: new Date(fetchEndMs).toISOString() },
  );

  // 4. Contiguity. Use the longest contiguous suffix ending at the latest bar.
  validateBarSeries(rawBars);
  const suffix = longestContiguousSuffix(rawBars);
  const gapsInRaw = findGaps(rawBars);
  if (suffix.length < SAMPLE_BARS + WARMUP_BARS) {
    fail(
      `contiguous suffix is only ${suffix.length} bars; need >= ${SAMPLE_BARS + WARMUP_BARS} ` +
      `(72 sample + 200 warmup). Backfill is incomplete or has a recent gap. ` +
      `gaps in fetched range: ${gapsInRaw.length}.`,
    );
  }
  // Trim to exactly warmup+sample ending at the last bar for a tidy fixture.
  const needed = suffix.slice(suffix.length - (SAMPLE_BARS + WARMUP_BARS));
  const warmupBars = needed.length - SAMPLE_BARS;
  console.log(`[p2d:live] contiguous window: ${needed.length} bars (${warmupBars} warmup + ${SAMPLE_BARS} sample)`);

  // 5. Compute features.
  const computed = computeFeaturesSegmented(needed);
  if (computed.segments.length !== 1) {
    fail(`expected 1 contiguous segment, got ${computed.segments.length} — window has a gap.`);
  }
  const rows = computed.rows;

  // 6. Sample window = last 72 rows.
  const sampleFeatures = rows.slice(rows.length - SAMPLE_BARS);
  const sampleTimestamps = sampleFeatures.map((f) => f.ts);
  const sampleStartTs = sampleTimestamps[0];
  const sampleEndTs   = sampleTimestamps[sampleTimestamps.length - 1];
  console.log(`[p2d:live] sample window: ${sampleStartTs} → ${sampleEndTs}`);

  // 7. TAAPI reference.
  const capturedAt = new Date().toISOString();
  const { reference, covered } = await fetchTaapiReference(key!, sampleTimestamps);
  console.log(`[p2d:live] TAAPI covered ${covered}/${sampleTimestamps.length} sampled timestamps`);

  // 8. Cross-validate.
  const report = crossValidate(sampleFeatures, reference, TOLERANCES, {
    symbol: SYMBOL, localExchange: EXCHANGE, referenceExchange: TAAPI_EXCHANGE,
    timeframe: TIMEFRAME, featureVersion: FEATURE_VERSION,
  });

  // 9. Internal checks.
  const vol = validateVolumeInternally(rows, needed);
  const bb  = validateBollingerInternally(rows, needed);

  // 10. Console summary.
  console.log("\n=== cross-validation summary ===");
  for (const s of report.indicatorSummaries) {
    console.log(`  ${s.indicator.padEnd(11)} pass=${s.passed} soft=${s.softFindings} hard=${s.hardFailures} (worst |Δ|=${s.worstAbsDiff.toPrecision(4)})`);
  }
  console.log(`  internal volume: ${vol.ok ? "PASS" : "FAIL"} (${vol.passed}/${vol.checked})`);
  console.log(`  internal bb:     ${bb.ok ? "PASS" : "FAIL"} (${bb.passed}/${bb.checked})`);
  console.log(`  hard failures: ${report.hardFailures.length}, soft findings: ${report.softFindings.length}`);

  // 11. Fixture (gated).
  if (updateFixture) {
    const fixture: P2DFixture = {
      metadata: {
        capturedAt,
        localExchange: EXCHANGE,
        localSymbol:   SYMBOL,
        taapiExchange: TAAPI_EXCHANGE,
        taapiSymbol:   TAAPI_SYMBOL,
        timeframe:     TIMEFRAME,
        featureVersion: FEATURE_VERSION,
        indicators: ["rsi14","macd","macdSignal","macdHist","ema20","ema50","ema200","atr14","bbUpper","bbMiddle","bbLower"],
        sampleStartTs: sampleStartTs,
        sampleEndTs:   sampleEndTs,
        sampledBars:   sampleFeatures.length,
        note: "TAAPI is Binance BTC/USDT, local is Coinbase BTC-USD. Cross-venue sanity check, not exact parity.",
      },
      localBars:      needed,
      localFeatures:  rows,
      taapiReference: reference,
    };
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
    console.log(`\n[p2d:live] wrote fixture: ${FIXTURE_PATH}`);
  } else {
    console.log("\n[p2d:live] UPDATE_P2D_FIXTURE not set — fixture NOT written (compare-only run).");
  }

  // 12. Report.
  const md = buildReport(report, vol, bb, capturedAt, warmupBars);
  fs.writeFileSync(REPORT_PATH, md);
  console.log(`[p2d:live] wrote report: ${REPORT_PATH}`);

  await closePgPool();

  const go = report.passed && vol.ok && bb.ok;
  console.log(`\n${go ? "✓ GO — no hard failures" : "✗ NO-GO — hard failures present"}`);
  if (!go) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  closePgPool().catch(() => {});
  process.exit(1);
});
