-- ============================================================================
-- 0001_initial_schema.sql
-- ============================================================================
-- Creates the full quant desk schema in one migration.
--
-- Tables created in public:
--   market_bars
--   feature_snapshots
--   regime_snapshots
--   strategy_signals
--   trade_intents
--   orders
--   fills
--   positions
--   agent_outputs
--
-- Tables created in backtest schema:
--   backtest.runs
--   backtest.trades
--
-- Plus:
--   _migrations               -- migration tracking (created by runner if absent)
--   trigger function for updated_at on positions/orders
--   indexes and RLS policies
--
-- Conventions documented inline. Read top-to-bottom.
-- ============================================================================

-- Required for gen_random_uuid()
create extension if not exists pgcrypto;

-- ============================================================================
-- backtest schema
-- ============================================================================
create schema if not exists backtest;

-- ============================================================================
-- Helper: trigger function for auto-updating updated_at columns
-- ============================================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- market_bars
-- ----------------------------------------------------------------------------
-- Raw OHLCV bars from exchange feeds. The source of truth for everything
-- downstream — features, regimes, signals, backtests all derive from here.
--
-- Conventions:
--   - ts is the bar OPEN timestamp (UTC). A 1h bar at 14:00 covers 14:00–15:00.
--   - Bars are stored ONLY after they close. No partial bars.
--   - volume is in BASE currency units (e.g. BTC for BTC-USD).
--   - One row per (symbol, exchange, timeframe, ts). Re-ingesting the same
--     bar is a no-op via the unique constraint.
-- ============================================================================
create table market_bars (
  id                  bigserial   primary key,
  symbol              text        not null,
  exchange            text        not null,
  timeframe           text        not null
    check (timeframe in ('1m', '5m', '15m', '1h', '1d')),
  ts                  timestamptz not null,
  open                numeric     not null,
  high                numeric     not null,
  low                 numeric     not null,
  close               numeric     not null,
  volume              numeric,
  trade_count         integer,
  data_source_version text        not null,   -- e.g. 'coinbase.ws.v1', 'coinbase.rest.v1'
  inserted_at         timestamptz not null default now(),

  constraint market_bars_unique_bar
    unique (symbol, exchange, timeframe, ts),
  constraint market_bars_ohlc_sanity
    check (high >= low and high >= open and high >= close and low <= open and low <= close)
);

-- DESC index for "last N bars" queries which dominate the read path
create index market_bars_recent on market_bars (symbol, exchange, timeframe, ts desc);

-- ============================================================================
-- feature_snapshots
-- ----------------------------------------------------------------------------
-- One row per (symbol, exchange, timeframe, ts, feature_version). Features
-- are computed from market_bars by the feature engine.
--
-- Why named columns and not jsonb: the ~20 features are bounded, type drift
-- via jsonb keys is silent corruption, and backtests scan a million rows so
-- column access beats jsonb. Truly experimental fields go in `extras`.
--
-- Versioning: feature_version is part of the unique key so re-running the
-- feature engine at a new version against the same bars adds new rows
-- rather than overwriting. Old versions are preserved.
-- ============================================================================
create table feature_snapshots (
  id                bigserial   primary key,
  bar_id            bigint      not null references market_bars(id) on delete cascade,
  symbol            text        not null,
  exchange          text        not null,
  timeframe         text        not null
    check (timeframe in ('1m', '5m', '15m', '1h', '1d')),
  ts                timestamptz not null,
  close             numeric     not null,

  -- Momentum / oscillators
  rsi14             numeric,
  macd              numeric,
  macd_signal       numeric,
  macd_hist         numeric,

  -- Trend
  ema20             numeric,
  ema50             numeric,
  ema200            numeric,
  ema20_slope       numeric,
  ema50_slope       numeric,
  ema200_slope      numeric,

  -- Volatility
  atr14             numeric,
  atr_pct           numeric,
  bb_upper          numeric,
  bb_middle         numeric,
  bb_lower          numeric,
  bb_width          numeric,
  bb_width_prev     numeric,

  -- Volume
  volume_sma20      numeric,
  relative_volume20 numeric,

  -- Derived
  distance_from_ema20_atr  numeric,
  candle_range_atr         numeric,

  -- Cross-timeframe (set on lower-tf rows from higher-tf features)
  daily_ema50_above_ema200 boolean,
  daily_price_above_ema200 boolean,

  -- Escape hatch for experimental fields. Promote to a column + bump
  -- feature_version when a field stabilizes.
  extras            jsonb,

  feature_version   text        not null,
  inserted_at       timestamptz not null default now(),

  constraint feature_snapshots_unique
    unique (symbol, exchange, timeframe, ts, feature_version)
);

create index feature_snapshots_recent
  on feature_snapshots (symbol, exchange, timeframe, ts desc);

-- ============================================================================
-- regime_snapshots
-- ----------------------------------------------------------------------------
-- Output of the regime detector (currently A6, later: deterministic regime
-- classifier). Permission/multipliers are denormalized so consumers don't
-- have to recompute from the regime label — they trust the snapshot.
-- ============================================================================
create table regime_snapshots (
  id                  bigserial   primary key,
  symbol              text        not null,
  exchange            text        not null,
  ts                  timestamptz not null,

  regime              text        not null
    check (regime in ('TREND_UP', 'TREND_DOWN', 'LOW_VOL', 'HIGH_VOL', 'CHOP', 'NEWS_SHOCK')),
  reliability         numeric     not null
    check (reliability >= 0 and reliability <= 1),
  directional_bias    text        not null
    check (directional_bias in ('UP', 'DOWN', 'NEUTRAL')),
  trade_permission    text        not null
    check (trade_permission in (
      'ALLOW_UP_ONLY', 'ALLOW_DOWN_ONLY',
      'ALLOW_BOTH', 'ALLOW_BOTH_SMALL',
      'BLOCK_OR_EXCEPTIONAL_ONLY', 'BLOCK'
    )),
  edge_multiplier     numeric     not null,
  size_multiplier     numeric     not null,
  reason              text,
  raw_response        jsonb,                          -- the underlying agent response, if any

  regime_model_version text       not null,
  prompt_version       text,
  feature_version      text,
  inserted_at          timestamptz not null default now()
);

create index regime_snapshots_recent on regime_snapshots (symbol, exchange, ts desc);

-- ============================================================================
-- strategy_signals
-- ----------------------------------------------------------------------------
-- Output of deterministic strategies. One row per (symbol, exchange,
-- timeframe, ts, strategy, strategy_version). A given strategy at a given
-- version fires at most once per bar.
--
-- direction = 'none' is allowed for non-directional signals (e.g. "squeeze
-- detected, no direction yet").
--
-- soft-delete via deleted_at: setting non-null retracts the signal from
-- live consideration without losing the audit row.
-- ============================================================================
create table strategy_signals (
  id                 bigserial   primary key,
  public_id          uuid        not null default gen_random_uuid() unique,
  symbol             text        not null,
  exchange           text        not null,
  timeframe          text        not null
    check (timeframe in ('1m', '5m', '15m', '1h', '1d')),
  ts                 timestamptz not null,

  strategy_id        text        not null,
  signal_type        text        not null
    check (signal_type in ('setup', 'trigger', 'exit', 'invalidated')),
  direction          text        not null
    check (direction in ('long', 'short', 'none')),
  confidence         numeric     not null
    check (confidence >= 0 and confidence <= 1),
  expected_edge      numeric,
  invalidation_price numeric,
  stop_loss          numeric,
  take_profit        numeric,
  reasons            text[],
  features_snapshot  jsonb,                           -- inline copy for audit

  strategy_version   text        not null,
  feature_version    text        not null,
  inserted_at        timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint strategy_signals_unique
    unique (symbol, exchange, timeframe, ts, strategy_id, strategy_version)
);

create index strategy_signals_recent
  on strategy_signals (symbol, exchange, ts desc);
create index strategy_signals_active
  on strategy_signals (strategy_id, ts desc)
  where deleted_at is null;

-- ============================================================================
-- trade_intents
-- ----------------------------------------------------------------------------
-- A risk-evaluated trade idea. Created post-risk, regardless of whether
-- it was approved.
--
-- source_signal_ids is an array because confluence can compose multiple
-- strategy signals into one intent.
-- ============================================================================
create table trade_intents (
  id                bigserial   primary key,
  public_id         uuid        not null default gen_random_uuid() unique,
  symbol            text        not null,
  exchange          text        not null,
  ts                timestamptz not null,

  source_signal_ids bigint[]    not null,
  direction         text        not null
    check (direction in ('long', 'short')),
  status            text        not null
    check (status in (
      'created', 'risk_rejected', 'risk_approved',
      'submitted', 'partially_filled', 'filled',
      'cancelled', 'closed', 'error'
    )),
  entry_logic       text,
  stop_loss         numeric,
  take_profit       numeric,
  suggested_size    numeric,
  max_risk_usd      numeric,
  risk_decision     jsonb,

  risk_version      text        not null,
  inserted_at       timestamptz not null default now(),
  deleted_at        timestamptz
);

create index trade_intents_recent on trade_intents (symbol, exchange, ts desc);
create index trade_intents_open
  on trade_intents (status)
  where status in ('risk_approved', 'submitted', 'partially_filled');

-- ============================================================================
-- orders
-- ----------------------------------------------------------------------------
-- One row per order submitted (paper or live). external_order_id is null
-- for paper orders.
-- ============================================================================
create table orders (
  id                bigserial   primary key,
  public_id         uuid        not null default gen_random_uuid() unique,
  trade_intent_id   bigint      not null references trade_intents(id) on delete restrict,
  symbol            text        not null,
  exchange          text        not null,
  side              text        not null check (side in ('buy', 'sell')),
  order_type        text        not null check (order_type in ('market', 'limit')),
  quantity          numeric     not null check (quantity > 0),
  limit_price       numeric,
  status            text        not null
    check (status in (
      'pending', 'submitted', 'partially_filled',
      'filled', 'cancelled', 'rejected', 'error'
    )),
  external_order_id text,
  submitted_at      timestamptz,
  updated_at        timestamptz not null default now()
);

create index orders_by_intent on orders (trade_intent_id);
create index orders_open
  on orders (status, updated_at desc)
  where status in ('submitted', 'partially_filled');

create trigger orders_set_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ============================================================================
-- fills
-- ----------------------------------------------------------------------------
-- Individual fills against an order. An order may have multiple fills if
-- partially filled.
--
-- fee is in QUOTE currency (USD for BTC-USD). raw stores the exchange-native
-- payload for audit and reconciliation.
-- ============================================================================
create table fills (
  id          bigserial   primary key,
  order_id    bigint      not null references orders(id) on delete restrict,
  symbol      text        not null,
  exchange    text        not null,
  side        text        not null check (side in ('buy', 'sell')),
  quantity    numeric     not null check (quantity > 0),
  price       numeric     not null check (price > 0),
  fee         numeric,
  filled_at   timestamptz not null,
  raw         jsonb,
  inserted_at timestamptz not null default now()
);

create index fills_by_order on fills (order_id);

-- ============================================================================
-- positions
-- ----------------------------------------------------------------------------
-- Tracks open and closed positions. Updated as fills land. One row per
-- position lifetime; we DO NOT create a new row when a position is partially
-- closed — quantity and avg_entry are mutated.
-- ============================================================================
create table positions (
  id              bigserial   primary key,
  public_id       uuid        not null default gen_random_uuid() unique,
  trade_intent_id bigint      not null references trade_intents(id) on delete restrict,
  symbol          text        not null,
  exchange        text        not null,
  status          text        not null check (status in ('open', 'closed')),
  direction       text        not null check (direction in ('long', 'short')),
  quantity        numeric     not null check (quantity >= 0),
  avg_entry       numeric     not null check (avg_entry > 0),
  stop_loss       numeric,
  take_profit     numeric,
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  realized_pnl    numeric,
  updated_at      timestamptz not null default now(),

  constraint positions_closed_has_closed_at
    check ((status = 'closed') = (closed_at is not null))
);

create index positions_open on positions (symbol, exchange) where status = 'open';
create index positions_recent on positions (symbol, exchange, opened_at desc);

create trigger positions_set_updated_at
  before update on positions
  for each row execute function set_updated_at();

-- ============================================================================
-- agent_outputs
-- ----------------------------------------------------------------------------
-- Outputs from the repurposed GPT agents. Agents are now specialists running
-- defined jobs on the deterministic pipeline:
--   - risk_reviewer:      reviews trade intents, flags concerns
--   - regime_analyst:     explains current regime in narrative form
--   - setup_interpreter:  describes what a deterministic signal means
--   - post_trade_reviewer: writes up closed positions
--   - anomaly_watcher:    flags pipeline behavior that looks off
--   - research_summarizer: produces daily/weekly digests
--
-- The agent_role enum is open-ended (text + check); add new roles by
-- updating the check constraint in a future migration.
--
-- Outputs are anchored to whatever the agent was reviewing via nullable FKs.
-- Each output sets at most one FK (in current usage; the schema doesn't
-- enforce mutual exclusion — research summaries may anchor to nothing).
-- ============================================================================
create table agent_outputs (
  id           bigserial   primary key,
  public_id    uuid        not null default gen_random_uuid() unique,
  agent_id     text        not null,                  -- e.g. 'risk_reviewer_v1'
  agent_role   text        not null
    check (agent_role in (
      'risk_review',
      'regime_explanation',
      'setup_interpretation',
      'post_trade_review',
      'anomaly_flag',
      'research_summary'
    )),
  symbol       text,                                  -- null for portfolio-wide outputs
  exchange     text,
  ts           timestamptz not null,

  -- What was being reviewed
  related_signal_id          bigint references strategy_signals(id) on delete set null,
  related_intent_id          bigint references trade_intents(id)    on delete set null,
  related_position_id        bigint references positions(id)        on delete set null,
  related_regime_snapshot_id bigint references regime_snapshots(id) on delete set null,

  -- The output itself
  summary      text        not null,
  details      jsonb,
  severity     text        check (severity in ('info', 'caution', 'alert')),
  tags         text[],

  -- Lineage
  prompt_version  text     not null,
  model_version   text     not null,
  feature_version text,
  inserted_at     timestamptz not null default now()
);

create index agent_outputs_by_agent  on agent_outputs (agent_id, ts desc);
create index agent_outputs_by_symbol on agent_outputs (symbol, exchange, ts desc) where symbol is not null;
create index agent_outputs_by_intent on agent_outputs (related_intent_id)         where related_intent_id is not null;
create index agent_outputs_by_pos    on agent_outputs (related_position_id)       where related_position_id is not null;
create index agent_outputs_alerts    on agent_outputs (ts desc)                   where severity = 'alert';

-- ============================================================================
-- backtest.runs
-- ----------------------------------------------------------------------------
-- One row per backtest invocation. metrics jsonb holds the BacktestMetrics
-- shape from lib/quant/types.ts.
-- ============================================================================
create table backtest.runs (
  id               bigserial   primary key,
  public_id        uuid        not null default gen_random_uuid() unique,
  strategy_id      text        not null,
  strategy_version text        not null,
  symbol           text        not null,
  exchange         text        not null,
  timeframe        text        not null
    check (timeframe in ('1m', '5m', '15m', '1h', '1d')),
  start_ts         timestamptz not null,
  end_ts           timestamptz not null,
  config           jsonb       not null,
  metrics          jsonb       not null,
  created_at       timestamptz not null default now(),

  constraint backtest_runs_window check (end_ts > start_ts)
);

create index backtest_runs_by_strategy on backtest.runs (strategy_id, strategy_version, created_at desc);

-- ============================================================================
-- backtest.trades
-- ----------------------------------------------------------------------------
-- Individual trades within a backtest run.
-- ============================================================================
create table backtest.trades (
  id              bigserial   primary key,
  backtest_run_id bigint      not null references backtest.runs(id) on delete cascade,
  symbol          text        not null,
  exchange        text        not null,
  direction       text        not null check (direction in ('long', 'short')),
  entry_ts        timestamptz not null,
  entry_price     numeric     not null,
  exit_ts         timestamptz,
  exit_price      numeric,
  quantity        numeric     not null,
  pnl             numeric,
  pnl_pct         numeric,
  reason_entered  text,
  reason_exited   text,
  regime_at_entry text
    check (regime_at_entry is null or regime_at_entry in ('TREND_UP', 'TREND_DOWN', 'LOW_VOL', 'HIGH_VOL', 'CHOP', 'NEWS_SHOCK')),
  inserted_at     timestamptz not null default now()
);

create index backtest_trades_by_run on backtest.trades (backtest_run_id);

-- ============================================================================
-- RLS — Row Level Security
-- ----------------------------------------------------------------------------
-- The service role bypasses RLS automatically; the worker uses the service
-- role. RLS only governs what the anon key can do (e.g. the Next.js
-- public-facing read APIs if they ever switch to anon-keyed queries).
--
-- Default: no anon access to anything. Then re-enable read on the public
-- market-data tables.
-- ============================================================================

alter table market_bars        enable row level security;
alter table feature_snapshots  enable row level security;
alter table regime_snapshots   enable row level security;
alter table strategy_signals   enable row level security;
alter table trade_intents      enable row level security;
alter table orders             enable row level security;
alter table fills              enable row level security;
alter table positions          enable row level security;
alter table agent_outputs      enable row level security;
alter table backtest.runs      enable row level security;
alter table backtest.trades    enable row level security;

-- Anon read on public market data and features only.
-- These are observable from the exchange anyway — leaking them costs nothing.
create policy anon_read_market_bars
  on market_bars for select to anon using (true);

create policy anon_read_feature_snapshots
  on feature_snapshots for select to anon using (true);

create policy anon_read_regime_snapshots
  on regime_snapshots for select to anon using (true);

-- strategy_signals and agent_outputs are NOT readable via anon. Leaking
-- these reveals the desk's positioning logic / agent commentary in real
-- time, which is information the venue does not give back. Reads from
-- the Next.js dashboard must go through service-role API routes until
-- a deliberate decision is made to expose them.
--
-- trade_intents, orders, fills, positions, backtest.* — also service-role
-- only. Add policies later if/when a public read path is needed.
