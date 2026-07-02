-- ============================================================================
-- 0005_risk_decisions.sql
-- ============================================================================
-- P11: wires the deterministic risk engine into the scheduled strategy signal
-- path. Every actionable ("trigger") strategy signal evaluated by
-- strategies.evaluate gets exactly one persisted decision per risk engine
-- version — approved or rejected. Trade intents are created only from
-- approved rows here; rejected decisions are never dropped or log-only.
-- ============================================================================

create table risk_decisions (
  id               bigserial   primary key,
  public_id        uuid        not null default gen_random_uuid() unique,

  signal_id        bigint      not null references strategy_signals(id),
  symbol           text        not null,
  exchange         text        not null,
  timeframe        text        not null,
  signal_ts        timestamptz not null,
  strategy_id      text        not null,

  approved         boolean     not null,
  reason           text        not null,
  blocked_by       text[]      not null default '{}',
  warnings         text[]      not null default '{}',
  size_multiplier  numeric     not null,
  max_risk_usd     numeric     not null,
  position_size    numeric     not null,
  stop_loss        numeric,
  take_profit      numeric,
  risk_version     text        not null,

  trade_intent_id  uuid        references trade_intents(public_id),
  evaluated_at     timestamptz not null,
  inserted_at      timestamptz not null default now(),

  -- Idempotency: the scheduled worker may rerun for the same closed bar.
  -- One decision per (signal, risk engine version) pair, ever.
  constraint risk_decisions_signal_risk_version_unique
    unique (signal_id, risk_version)
);

create index if not exists risk_decisions_symbol_evaluated_at
  on risk_decisions (symbol, evaluated_at desc);

create index if not exists risk_decisions_approved_evaluated_at
  on risk_decisions (approved, evaluated_at desc);

-- Second idempotency guard, at the trade_intents layer: one approved intent
-- per (signal, risk version) pair created by the scheduled risk gate.
-- Explicitly scoped to strategies.evaluate-authored intents via
-- metadata->>'source' (set by runScheduledRiskGate on every intent it
-- creates) so manual / API-driven paper-workflow intents — which never set
-- that metadata key and typically carry a non-numeric or empty
-- source_signal_ids array — can never collide with this constraint.
create unique index if not exists trade_intents_signal_risk_version_unique
  on trade_intents (source_signal_ids, risk_version)
  where cardinality(source_signal_ids) > 0
    and metadata->>'source' = 'strategies.evaluate';

comment on table risk_decisions is
  'P11: durable, audit-grade record of every risk-engine evaluation for an actionable trigger signal on the scheduled strategies.evaluate path. Rejected decisions are persisted here, not only logged.';
