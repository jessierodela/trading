-- Add P8A durable job queue and persisted dashboard snapshot contract.
--
-- These are internal server-side tables. They can contain strategy state,
-- risk decisions, paper-trading state, and pipeline metadata. Do not expose
-- anonymous/client writes. Access must go through server routes or workers
-- using server-side credentials.

create table jobs (
  id bigserial primary key,
  public_id uuid not null default gen_random_uuid() unique,

  job_type text not null,
  status text not null,

  priority integer not null default 100,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,

  dedupe_key text,
  run_after timestamptz not null default now(),

  attempts integer not null default 0,
  max_attempts integer not null default 3,

  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,

  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  constraint jobs_job_type_check
    check (job_type in (
      'market.ingest.latest',
      'features.compute',
      'regime.compute',
      'strategies.evaluate',
      'paper.monitor',
      'dashboard.snapshot',
      'telegram.refresh'
    )),
  constraint jobs_payload_job_type_matches
    check (payload ? 'jobType' and payload->>'jobType' = job_type),
  constraint jobs_attempts_nonnegative check (attempts >= 0),
  constraint jobs_max_attempts_positive check (max_attempts > 0),
  constraint jobs_priority_nonnegative check (priority >= 0)
);

comment on table jobs is
  'P8A internal durable job queue. Server routes/workers only; no anonymous/client writes.';
comment on column jobs.status is
  'queued=claimable, running=leased, succeeded=terminal success, failed=terminal non-retryable failure, cancelled=terminal cancellation, dead=retry-exhausted failure.';
comment on column jobs.job_type is
  'Whitelisted P8 paper-only pipeline job type. Live execution job types are intentionally forbidden.';

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

create unique index jobs_dedupe_active
  on jobs (job_type, dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'running');

create index jobs_claimable
  on jobs (priority asc, run_after asc, id asc)
  where status = 'queued';

create index jobs_expired_leases
  on jobs (lease_expires_at asc)
  where status = 'running';

create index jobs_status_recent
  on jobs (status, created_at desc);

create table job_events (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  event_type text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table job_events is
  'P8A internal audit log for job lifecycle transitions. Lifecycle methods append events transactionally with job row updates.';

create index job_events_by_job
  on job_events (job_id, created_at asc);

create table dashboard_snapshots (
  id bigserial primary key,
  public_id uuid not null default gen_random_uuid() unique,

  snapshot_type text not null,
  symbol text,
  timeframe text,

  payload jsonb not null default '{}'::jsonb,

  source_job_id bigint references jobs(id) on delete set null,

  generated_at timestamptz not null,
  expires_at timestamptz,

  created_at timestamptz not null default now(),

  constraint dashboard_snapshots_type_check
    check (snapshot_type in ('dashboard', 'signals', 'regime', 'paper', 'telegram'))
);

comment on table dashboard_snapshots is
  'P8A internal persisted dashboard output contract. Server routes/workers only; no anonymous/client writes.';

create index dashboard_snapshots_latest
  on dashboard_snapshots (snapshot_type, symbol, timeframe, generated_at desc);

create index dashboard_snapshots_source_job
  on dashboard_snapshots (source_job_id);

alter table jobs enable row level security;
alter table job_events enable row level security;
alter table dashboard_snapshots enable row level security;
