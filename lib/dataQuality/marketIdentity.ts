import type { Exchange } from "@/lib/quant/types";
import type { DataQualityIssue } from "./types";

export type MarketDataSource = "coinbase" | "polygon" | "taapi" | "yahoo" | "unknown";

export interface MarketIdentity {
  canonicalSymbol: string;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: Exchange;
  source: MarketDataSource;
  vendorSymbol?: string;
  normalizedFrom?: string;
}

export interface MarketIdentityInput {
  symbol: string;
  exchange?: string | null;
  source?: string | null;
  vendorSymbol?: string | null;
  quoteAsset?: string | null;
}

const KNOWN_QUOTES = ["USDT", "USD", "USDC", "BTC", "ETH"] as const;

export function isUsdtQuoteMarketSymbol(value: string): boolean {
  const normalized = value.trim().toUpperCase().replace("/", "-");
  if (normalized.length === 0) return false;
  if (normalized.endsWith("-USDT")) return true;
  return normalized.endsWith("USDT") && normalized.length > "USDT".length && !normalized.includes("-");
}

export function scheduledMarketIdentityErrorMessage(symbol: string): string {
  const rendered = symbol.trim().toUpperCase() || "UNKNOWN";
  const parsed = parseSymbol(symbol);
  const canonical = parsed.base ? `${parsed.base}-USD` : "BTC-USD";
  return `${rendered} is not the canonical scheduled market. Use ${canonical} on COINBASE/coinbase, or add an explicit normalization policy.`;
}

function normalizeExchange(value: string | null | undefined, source: MarketDataSource): Exchange {
  const upper = value?.trim().toUpperCase();
  if (upper === "COINBASE" || upper === "BINANCE" || upper === "POLYGON") return upper;
  if (source === "taapi") return "BINANCE";
  if (source === "polygon" || source === "yahoo") return "POLYGON";
  return "COINBASE";
}

function normalizeSource(value: string | null | undefined): MarketDataSource {
  const lower = value?.trim().toLowerCase();
  if (lower === "coinbase" || lower === "polygon" || lower === "taapi" || lower === "yahoo") return lower;
  return "unknown";
}

function parseSymbol(raw: string, quoteOverride?: string | null): { base: string; quote: string } {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) return { base: "", quote: quoteOverride?.trim().toUpperCase() || "USD" };
  const explicit = trimmed.match(/^([A-Z0-9]+)[/-]([A-Z0-9]+)$/);
  if (explicit) {
    return { base: explicit[1], quote: quoteOverride?.trim().toUpperCase() || explicit[2] };
  }
  for (const quote of KNOWN_QUOTES) {
    if (trimmed.endsWith(quote) && trimmed.length > quote.length) {
      return { base: trimmed.slice(0, -quote.length), quote: quoteOverride?.trim().toUpperCase() || quote };
    }
  }
  return { base: trimmed, quote: quoteOverride?.trim().toUpperCase() || "USD" };
}

export function normalizeMarketIdentity(input: MarketIdentityInput): MarketIdentity {
  const source = normalizeSource(input.source);
  const exchange = normalizeExchange(input.exchange, source);
  const vendorSymbol = (input.vendorSymbol ?? input.symbol).trim();
  const parsed = parseSymbol(vendorSymbol, input.quoteAsset);
  const baseAsset = parsed.base;
  const quoteAsset = parsed.quote;
  const canonicalSymbol = baseAsset && quoteAsset ? `${baseAsset}-${quoteAsset}` : vendorSymbol.toUpperCase();

  return {
    canonicalSymbol,
    displaySymbol: baseAsset,
    baseAsset,
    quoteAsset,
    exchange,
    source,
    vendorSymbol,
    normalizedFrom: vendorSymbol.toUpperCase() === canonicalSymbol ? undefined : vendorSymbol,
  };
}

export function canonicalScheduledIdentity(symbol = "BTC-USD"): MarketIdentity {
  return normalizeMarketIdentity({
    symbol,
    exchange: "COINBASE",
    source: "coinbase",
  });
}

export function describeMarketIdentity(identity: MarketIdentity): string {
  const source = identity.source === "unknown" ? "source=unknown" : `source=${identity.source}`;
  const normalized = identity.normalizedFrom ? `, normalizedFrom=${identity.normalizedFrom}` : "";
  return `${identity.canonicalSymbol} (${identity.exchange}, ${source}, quote=${identity.quoteAsset}${normalized})`;
}

export function assertCompatibleMarketIdentity(
  expected: MarketIdentity,
  actual: MarketIdentity,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const base = {
    symbol: actual.canonicalSymbol,
    exchange: actual.exchange,
    source: actual.source,
    expected: describeMarketIdentity(expected),
    actual: describeMarketIdentity(actual),
  };

  if (actual.baseAsset !== expected.baseAsset) {
    issues.push({
      ...base,
      code: "MARKET_BASE_MISMATCH",
      severity: "block",
      message: `Market base asset mismatch: expected ${expected.baseAsset}, got ${actual.baseAsset}.`,
    });
  }
  if (actual.quoteAsset !== expected.quoteAsset) {
    issues.push({
      ...base,
      code: "MARKET_QUOTE_MISMATCH",
      severity: "block",
      message: `Market quote asset mismatch: expected ${expected.quoteAsset}, got ${actual.quoteAsset}.`,
    });
  }
  if (actual.canonicalSymbol !== expected.canonicalSymbol) {
    issues.push({
      ...base,
      code: "MARKET_SYMBOL_MISMATCH",
      severity: "block",
      message: `Market symbol mismatch: expected ${expected.canonicalSymbol}, got ${actual.canonicalSymbol}.`,
    });
  }
  if (actual.exchange !== expected.exchange) {
    issues.push({
      ...base,
      code: "MARKET_EXCHANGE_MISMATCH",
      severity: "block",
      message: `Market exchange mismatch: expected ${expected.exchange}, got ${actual.exchange}.`,
    });
  }
  if (expected.source !== "unknown" && actual.source !== "unknown" && actual.source !== expected.source) {
    issues.push({
      ...base,
      code: "MARKET_SOURCE_MISMATCH",
      severity: "block",
      message: `Market source mismatch: expected ${expected.source}, got ${actual.source}.`,
    });
  }

  if (actual.normalizedFrom && issues.length === 0) {
    issues.push({
      ...base,
      code: "MARKET_SYMBOL_NORMALIZED",
      severity: "warn",
      message: `Market symbol was explicitly normalized from ${actual.normalizedFrom} to ${actual.canonicalSymbol}.`,
    });
  }

  return issues;
}
