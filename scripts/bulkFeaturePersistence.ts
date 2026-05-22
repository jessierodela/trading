import type { Pool } from "pg";
import type { FeatureSnapshot } from "@/lib/quant/types";

const FEATURE_COLUMNS: Array<{ column: string; field: keyof FeatureSnapshot }> = [
  { column: "rsi14", field: "rsi14" },
  { column: "macd", field: "macd" },
  { column: "macd_signal", field: "macdSignal" },
  { column: "macd_hist", field: "macdHist" },
  { column: "ema20", field: "ema20" },
  { column: "ema50", field: "ema50" },
  { column: "ema200", field: "ema200" },
  { column: "ema20_slope", field: "ema20Slope" },
  { column: "ema50_slope", field: "ema50Slope" },
  { column: "ema200_slope", field: "ema200Slope" },
  { column: "atr14", field: "atr14" },
  { column: "atr_pct", field: "atrPct" },
  { column: "bb_upper", field: "bbUpper" },
  { column: "bb_middle", field: "bbMiddle" },
  { column: "bb_lower", field: "bbLower" },
  { column: "bb_width", field: "bbWidth" },
  { column: "bb_width_prev", field: "bbWidthPrev" },
  { column: "volume_sma20", field: "volumeSma20" },
  { column: "relative_volume20", field: "relativeVolume20" },
  { column: "distance_from_ema20_atr", field: "distanceFromEma20Atr" },
  { column: "candle_range_atr", field: "candleRangeAtr" },
  { column: "daily_ema50_above_ema200", field: "daily_ema50AboveEma200" },
  { column: "daily_price_above_ema200", field: "daily_priceAboveEma200" },
];

export async function insertFeatureSnapshotsBulk(
  pool: Pool,
  snapshots: FeatureSnapshot[],
  chunkSize = 500,
): Promise<number> {
  let inserted = 0;
  const columns = [
    "symbol",
    "exchange",
    "timeframe",
    "ts",
    "close",
    "feature_version",
    ...FEATURE_COLUMNS.map((column) => column.column),
  ];
  const booleanColumns = new Set(["daily_ema50_above_ema200", "daily_price_above_ema200"]);
  const numericColumns = new Set([
    "close",
    ...FEATURE_COLUMNS
      .map((column) => column.column)
      .filter((column) => !booleanColumns.has(column)),
  ]);
  const selectExpressionFor = (column: string): string => {
    if (column === "ts") return "i.ts::timestamptz";
    if (numericColumns.has(column)) return `i.${column}::numeric`;
    if (booleanColumns.has(column)) return `i.${column}::boolean`;
    return `i.${column}`;
  };

  for (let offset = 0; offset < snapshots.length; offset += chunkSize) {
    const chunk = snapshots.slice(offset, offset + chunkSize);
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const snapshot of chunk) {
      const rowValues = [
        snapshot.symbol,
        snapshot.exchange,
        snapshot.timeframe,
        snapshot.ts,
        snapshot.close,
        snapshot.featureVersion,
        ...FEATURE_COLUMNS.map(({ field }) => snapshot[field] ?? null),
      ];
      valuesSql.push(`(${rowValues.map(() => `$${paramIndex++}`).join(", ")})`);
      params.push(...rowValues);
    }

    const { rowCount } = await pool.query(
      `with incoming (${columns.join(", ")}) as (
         values ${valuesSql.join(", ")}
       )
       insert into feature_snapshots (
         bar_id, ${columns.join(", ")}
       )
       select
         b.id,
         ${columns.map(selectExpressionFor).join(", ")}
       from incoming i
       join market_bars b
         on b.symbol = i.symbol
        and b.exchange = i.exchange
        and b.timeframe = i.timeframe
        and b.ts = i.ts::timestamptz
       on conflict on constraint feature_snapshots_unique do nothing`,
      params,
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}
