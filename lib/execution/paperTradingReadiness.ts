import { FEATURE_VERSION, RISK_VERSION, STRATEGY_VERSIONS } from "@/lib/versions";
import type { RiskConfig } from "@/lib/risk/types";

export type PaperTradingReadinessCheckId =
  | "risk_engine_configured"
  | "kill_switch_configured"
  | "postgres_reachable"
  | "paper_tables_readable_writable"
  | "paper_api_auth_configured"
  | "dashboard_positions_readable"
  | "no_live_broker_env_required"
  | "no_live_broker_clients_imported"
  | "latest_strategy_version_present"
  | "latest_feature_version_present"
  | "risk_version_present";

export interface PaperTradingReadinessCheck {
  id: PaperTradingReadinessCheckId;
  label: string;
  ok: boolean;
  severity: "blocker" | "warning";
  message: string;
}

export interface PaperTradingReadinessReport {
  ok: boolean;
  generatedAt: string;
  checks: PaperTradingReadinessCheck[];
}

export interface PaperTradingDbReadiness {
  postgresReachable: boolean;
  paperTablesReadableWritable: boolean;
  message: string;
}

export interface PaperTradingDashboardReadiness {
  canReadPositions: boolean;
  message: string;
}

export interface LiveBrokerImportScan {
  found: boolean;
  matches: string[];
}

export interface PaperTradingReadinessInput {
  riskConfig?: RiskConfig;
  env?: Record<string, string | undefined>;
  generatedAt?: string;
  dbCheck?: () => Promise<PaperTradingDbReadiness>;
  dashboardCheck?: () => Promise<PaperTradingDashboardReadiness>;
  liveBrokerImportScanner?: () => Promise<LiveBrokerImportScan>;
  versions?: {
    strategyVersions?: Record<string, string>;
    featureVersion?: string;
    riskVersion?: string;
  };
}

export const PAPER_TRADING_REQUIRED_ENV = [
  "SUPABASE_DB_URL or DATABASE_URL",
  "PAPER_TRADING_API_KEY",
  "PAPER_TRADING_KILL_SWITCH or PAPER_TRADING_KILL_SWITCH_ENABLED",
] as const;

export const LIVE_BROKER_ENV_KEYS = [
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BROKER_API_KEY",
  "BROKER_SECRET",
  "COINBASE_API_KEY",
  "COINBASE_API_SECRET",
  "EXCHANGE_API_KEY",
  "EXCHANGE_API_SECRET",
  "LIVE_BROKER_URL",
] as const;

function check(
  id: PaperTradingReadinessCheckId,
  label: string,
  ok: boolean,
  message: string,
  severity: PaperTradingReadinessCheck["severity"] = "blocker",
): PaperTradingReadinessCheck {
  return { id, label, ok, message, severity };
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isFinitePositive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function riskConfigIsOperational(config: RiskConfig | undefined): boolean {
  if (!config) return false;
  return (
    config.enabled === true &&
    (config.allowLong || config.allowShort) &&
    isFinitePositive(config.maxRiskPerTradePct) &&
    isFinitePositive(config.maxDailyLossPct) &&
    isFinitePositive(config.maxOpenPositions) &&
    isFinitePositive(config.maxSymbolExposurePct) &&
    isFinitePositive(config.maxPortfolioExposurePct) &&
    isFiniteNonNegative(config.minRegimeReliability) &&
    config.minRegimeReliability <= 1 &&
    Array.isArray(config.blockedRegimes) &&
    typeof config.allowDefaultStopFallback === "boolean" &&
    isFinitePositive(config.defaultStopLossPct) &&
    isFinitePositive(config.defaultTakeProfitPct) &&
    isFinitePositive(config.maxLeverage) &&
    isFinitePositive(config.staleSignalMaxAgeMs) &&
    isFiniteNonNegative(config.duplicateCooldownMs) &&
    isFiniteNonNegative(config.highVolSizeMultiplier) &&
    isFiniteNonNegative(config.chopSizeMultiplier) &&
    typeof config.newsShockBlocksTrading === "boolean" &&
    typeof config.killSwitchEnabled === "boolean"
  );
}

function killSwitchIsConfigured(config: RiskConfig | undefined, env: Record<string, string | undefined>): boolean {
  const envValue = env.PAPER_TRADING_KILL_SWITCH ?? env.PAPER_TRADING_KILL_SWITCH_ENABLED;
  const envConfigured = envValue === "true" || envValue === "false";
  return envConfigured || typeof config?.killSwitchEnabled === "boolean";
}

async function defaultPostgresReadiness(
  env: Record<string, string | undefined>,
): Promise<PaperTradingDbReadiness> {
  if (!hasText(env.SUPABASE_DB_URL) && !hasText(env.DATABASE_URL)) {
    return {
      postgresReachable: false,
      paperTablesReadableWritable: false,
      message: "Set SUPABASE_DB_URL or DATABASE_URL before the 30-day paper run.",
    };
  }

  try {
    const { getPgPool } = await import("@/lib/storage");
    const pool = getPgPool();
    await pool.query("select 1");
    const schema = await pool.query<{ ready: boolean }>(`
      select count(*) = 4 as ready
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('trade_intents', 'orders', 'fills', 'positions')
    `);
    if (!schema.rows[0]?.ready) {
      return {
        postgresReachable: true,
        paperTablesReadableWritable: false,
        message: "Postgres is reachable, but P7B paper trading tables are not all present.",
      };
    }

    const privileges = await pool.query<{ ready: boolean }>(`
      select bool_and(
        has_table_privilege('public.' || table_name, 'select') and
        has_table_privilege('public.' || table_name, 'insert') and
        has_table_privilege('public.' || table_name, 'update')
      ) as ready
      from (values ('trade_intents'), ('orders'), ('fills'), ('positions')) as paper_tables(table_name)
    `);
    return {
      postgresReachable: true,
      paperTablesReadableWritable: privileges.rows[0]?.ready === true,
      message: privileges.rows[0]?.ready === true
        ? "Postgres is reachable and paper trading tables expose select/insert/update privileges."
        : "Postgres is reachable, but paper trading table privileges are incomplete.",
    };
  } catch (err) {
    return {
      postgresReachable: false,
      paperTablesReadableWritable: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultDashboardReadiness(
  env: Record<string, string | undefined>,
): Promise<PaperTradingDashboardReadiness> {
  if (!hasText(env.SUPABASE_DB_URL) && !hasText(env.DATABASE_URL)) {
    return {
      canReadPositions: false,
      message: "Dashboard cannot read positions until SUPABASE_DB_URL or DATABASE_URL is configured.",
    };
  }

  const { loadPaperTradingDashboardData } = await import("@/lib/dashboard/paperTrading");
  const data = await loadPaperTradingDashboardData();
  return {
    canReadPositions: data.state === "ready",
    message: data.statusMessage,
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) return [fullPath];
    return [];
  }));
  return nested.flat();
}

async function defaultLiveBrokerImportScanner(): Promise<LiveBrokerImportScan> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const roots = [
    path.join(process.cwd(), "lib", "execution"),
    path.join(process.cwd(), "app", "api", "orders"),
  ];
  const files = (await Promise.all(roots.map(listSourceFiles)))
    .flat()
    .filter((file) => path.basename(file) !== "paperTradingReadiness.ts");
  const forbiddenImports = [
    /from\s+["'][^"']*(alpaca|binance|ccxt|kraken|ibkr|coinbase-advanced|coinbase-pro)[^"']*["']/i,
    /require\(["'][^"']*(alpaca|binance|ccxt|kraken|ibkr|coinbase-advanced|coinbase-pro)[^"']*["']\)/i,
    /\bsubmitLiveOrder\b/i,
    /\bcreateLiveOrder\b/i,
    /\bliveBrokerClient\b/i,
  ];
  const matches: string[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const relative = path.relative(process.cwd(), file);
    for (const pattern of forbiddenImports) {
      if (pattern.test(text)) matches.push(`${relative}: ${pattern.source}`);
    }
  }

  return {
    found: matches.length > 0,
    matches,
  };
}

export async function runPaperTradingReadinessChecks(
  input: PaperTradingReadinessInput = {},
): Promise<PaperTradingReadinessReport> {
  const env = input.env ?? process.env;
  const versions = input.versions ?? {};
  const strategyVersions = versions.strategyVersions ?? STRATEGY_VERSIONS;
  const featureVersion = versions.featureVersion ?? FEATURE_VERSION;
  const riskVersion = versions.riskVersion ?? RISK_VERSION;
  const checks: PaperTradingReadinessCheck[] = [];

  checks.push(check(
    "risk_engine_configured",
    "Risk engine configured",
    riskConfigIsOperational(input.riskConfig),
    input.riskConfig
      ? "Risk config is enabled with position, exposure, stale-signal, regime, and kill-switch fields present."
      : "Risk config is required before starting the 30-day paper run.",
  ));

  checks.push(check(
    "kill_switch_configured",
    "Kill switch configured",
    killSwitchIsConfigured(input.riskConfig, env),
    "Paper trading has a kill-switch value available from risk config or PAPER_TRADING_KILL_SWITCH.",
  ));

  const db = input.dbCheck ? await input.dbCheck() : await defaultPostgresReadiness(env);
  checks.push(check(
    "postgres_reachable",
    "Postgres reachable",
    db.postgresReachable,
    db.message,
  ));
  checks.push(check(
    "paper_tables_readable_writable",
    "Paper tables readable/writable",
    db.paperTablesReadableWritable,
    db.message,
  ));

  checks.push(check(
    "paper_api_auth_configured",
    "Paper API auth configured",
    hasText(env.PAPER_TRADING_API_KEY),
    hasText(env.PAPER_TRADING_API_KEY)
      ? "PAPER_TRADING_API_KEY is configured."
      : "Set PAPER_TRADING_API_KEY before exposing paper API routes.",
  ));

  const dashboard = input.dashboardCheck ? await input.dashboardCheck() : await defaultDashboardReadiness(env);
  checks.push(check(
    "dashboard_positions_readable",
    "Dashboard can read positions",
    dashboard.canReadPositions,
    dashboard.message,
  ));

  const liveEnvKeys = LIVE_BROKER_ENV_KEYS.filter((key) => hasText(env[key]));
  checks.push(check(
    "no_live_broker_env_required",
    "No live broker env vars required",
    true,
    liveEnvKeys.length === 0
      ? "Paper readiness does not depend on live broker credentials."
      : `Paper readiness ignores live broker credentials if present: ${liveEnvKeys.join(", ")}.`,
    liveEnvKeys.length === 0 ? "blocker" : "warning",
  ));

  const liveImports = input.liveBrokerImportScanner
    ? await input.liveBrokerImportScanner()
    : await defaultLiveBrokerImportScanner();
  checks.push(check(
    "no_live_broker_clients_imported",
    "No live broker clients imported",
    !liveImports.found,
    liveImports.found
      ? `Live broker import references found: ${liveImports.matches.join("; ")}`
      : "Paper execution modules do not import live broker clients.",
  ));

  checks.push(check(
    "latest_strategy_version_present",
    "Latest strategy version present",
    Object.values(strategyVersions).some((value) => typeof value === "string" && value.trim().length > 0),
    "At least one current strategy version must be available for signal lineage.",
  ));
  checks.push(check(
    "latest_feature_version_present",
    "Latest feature version present",
    hasText(featureVersion),
    "FEATURE_VERSION must be available for feature lineage.",
  ));
  checks.push(check(
    "risk_version_present",
    "Risk version present",
    hasText(riskVersion),
    "RISK_VERSION must be available for risk lineage.",
  ));

  return {
    ok: checks.every((item) => item.ok || item.severity === "warning"),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    checks,
  };
}
