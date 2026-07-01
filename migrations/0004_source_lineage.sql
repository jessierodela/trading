-- ============================================================================
-- 0004_source_lineage.sql
-- ============================================================================
-- Adds durable provider/source lineage metadata for new persisted rows.
--
-- This migration is intentionally additive. It does not rewrite historical rows
-- or infer source metadata for old data. Legacy rows remain auditable as missing
-- lineage until a future read-only audit or explicit backfill policy handles
-- them.
-- ============================================================================

alter table market_bars
  add column if not exists source text,
  add column if not exists vendor_symbol text,
  add column if not exists quote_asset text,
  add column if not exists source_lineage jsonb not null default '{}'::jsonb;

alter table feature_snapshots
  add column if not exists source text,
  add column if not exists vendor_symbol text,
  add column if not exists quote_asset text,
  add column if not exists source_lineage jsonb not null default '{}'::jsonb;

alter table regime_snapshots
  add column if not exists source_lineage jsonb not null default '{}'::jsonb;

alter table strategy_signals
  add column if not exists source_lineage jsonb not null default '{}'::jsonb;

create index if not exists market_bars_source_lineage_gin
  on market_bars using gin (source_lineage);

create index if not exists feature_snapshots_source_lineage_gin
  on feature_snapshots using gin (source_lineage);
