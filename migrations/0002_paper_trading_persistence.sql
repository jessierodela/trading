-- Add the P7A paper-trading state and lineage to the existing execution tables.
-- This migration is additive: the original tables remain the source of truth.

alter table trade_intents
  add column if not exists timeframe text,
  add column if not exists source_signal_refs text[] not null default '{}',
  add column if not exists strategy_id text,
  add column if not exists strategy_version text,
  add column if not exists feature_version text,
  add column if not exists entry_price numeric,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz,
  add column if not exists expires_at timestamptz;

update trade_intents
set created_at = inserted_at
where created_at is null;

update trade_intents
set source_signal_refs = array(
  select source_id::text
  from unnest(source_signal_ids) as source_id
)
where cardinality(source_signal_refs) = 0
  and cardinality(source_signal_ids) > 0;

alter table trade_intents drop constraint if exists trade_intents_status_check;
alter table trade_intents add constraint trade_intents_status_check
  check (status in (
    'created', 'risk_rejected', 'risk_approved', 'expired',
    'submitted', 'partially_filled', 'filled',
    'cancelled', 'closed', 'error'
  ));

alter table orders
  add column if not exists timeframe text,
  add column if not exists requested_price numeric,
  add column if not exists reason text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists filled_at timestamptz,
  add column if not exists fill_price numeric,
  add column if not exists slippage_bps numeric not null default 0,
  add column if not exists fee_bps numeric not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in (
    'created', 'accepted', 'pending', 'submitted', 'partially_filled',
    'filled', 'cancelled', 'rejected', 'error'
  ));
alter table orders add constraint orders_paper_slippage_nonnegative check (slippage_bps >= 0);
alter table orders add constraint orders_paper_fee_nonnegative check (fee_bps >= 0);

alter table fills
  add column if not exists requested_price numeric,
  add column if not exists slippage_cost numeric not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table fills add constraint fills_paper_slippage_nonnegative check (slippage_cost >= 0);

create unique index if not exists fills_one_per_paper_order
  on fills (order_id)
  where metadata @> '{"paperOnly": true}'::jsonb;

alter table positions
  add column if not exists order_id bigint references orders(id) on delete restrict,
  add column if not exists timeframe text,
  add column if not exists mark_price numeric,
  add column if not exists exit_price numeric,
  add column if not exists unrealized_pnl numeric not null default 0,
  add column if not exists fees numeric not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists positions_one_per_paper_order
  on positions (order_id)
  where order_id is not null;

create index if not exists orders_paper_recent
  on orders (created_at desc)
  where external_order_id is null;

create index if not exists positions_paper_status_recent
  on positions (status, opened_at desc)
  where order_id is not null;

comment on column trade_intents.source_signal_refs is
  'String-preserving signal lineage used by the paper-trading workflow.';
comment on column orders.metadata is
  'Paper-trading lineage and audit metadata. P7 stores require paperOnly=true.';
comment on column positions.metadata is
  'Paper-trading lineage, close reason, fee, slippage, and PnL audit metadata.';
