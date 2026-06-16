# Paper Trading Runbook

Priority 7E prepares paper trading for a 30-day operational run. This runbook keeps the path paper-only:

`strategy signal -> risk decision -> trade intent -> persisted paper order -> deterministic fill -> persisted position -> explicit position monitoring update -> persisted close/PnL -> dashboard visibility`

There is no live broker integration in this workflow. Do not add real exchange order submission, production live toggles, or automatic migration from paper to live during the paper run.

## Required Environment

- `SUPABASE_DB_URL` or `DATABASE_URL`: Postgres connection string with the P7B migration applied.
- `PAPER_TRADING_API_KEY`: internal API key required by paper trading API routes.
- `PAPER_TRADING_KILL_SWITCH` or `PAPER_TRADING_KILL_SWITCH_ENABLED`: set to `false` to allow new paper entries, `true` to block new entries.

Live broker credentials are not required for paper trading readiness.

## Start Paper Trading

1. Apply migrations:

   ```powershell
   npm.cmd run migrate
   ```

2. Run local validation:

   ```powershell
   npm.cmd exec -- tsc --noEmit --pretty false
   npm.cmd run smoke:paper-trading
   npm.cmd run smoke:paper-trading:persistence
   npm.cmd run smoke:paper-trading:api
   npm.cmd run smoke:paper-trading:dashboard
   npm.cmd run smoke:paper-trading:workflow
   ```

3. Verify readiness from code before the run:

   - Risk engine config is enabled.
   - Kill switch is configured.
   - Postgres is reachable.
   - Paper tables are readable and writable.
   - Paper API auth is configured.
   - Dashboard can read positions.
   - Latest strategy, feature, and risk versions are present.
   - No live broker client is imported by paper execution modules.

4. Set `PAPER_TRADING_KILL_SWITCH=false`.

5. Start the app or worker path that calls `createPaperTradeFromSignal(...)` for approved strategy triggers and `monitorPaperPositions(...)` for each closed bar.

## Stop With Kill Switch

Set either kill-switch env var to `true`:

```powershell
$env:PAPER_TRADING_KILL_SWITCH='true'
```

The kill switch blocks new paper entries. Existing positions still need explicit monitoring or manual close handling so PnL remains complete.

## Inspect Open Positions

Use the dashboard paper trading panel, or query the API route:

```powershell
curl.exe -H "x-internal-api-key: $env:PAPER_TRADING_API_KEY" "http://localhost:3000/api/positions?status=open"
```

For direct database inspection:

```sql
select public_id, symbol, exchange, timeframe, direction, quantity, mark_price, unrealized_pnl, fees, opened_at
from positions
where metadata->>'paperOnly' = 'true'
  and status = 'open'
order by opened_at desc;
```

## Inspect Closed Trades

Use the dashboard closed trades table, or query:

```powershell
curl.exe -H "x-internal-api-key: $env:PAPER_TRADING_API_KEY" "http://localhost:3000/api/positions?status=closed"
```

Direct SQL:

```sql
select public_id, symbol, direction, quantity, avg_entry, exit_price, realized_pnl, fees, closed_at, metadata->>'closeReason' as close_reason
from positions
where metadata->>'paperOnly' = 'true'
  and status = 'closed'
order by closed_at desc;
```

## Export PnL

Export closed paper trades from Postgres:

```sql
copy (
  select public_id, symbol, exchange, timeframe, direction, quantity, avg_entry, exit_price,
         realized_pnl, fees, opened_at, closed_at, metadata
  from positions
  where metadata->>'paperOnly' = 'true'
    and status = 'closed'
  order by closed_at asc
) to stdout with csv header;
```

The dashboard summary should match the exported realized PnL and fee totals.

## Verify No Live Execution Path

Before and during the run:

- Confirm no live broker credentials are required by readiness checks.
- Confirm paper execution modules import only paper broker, paper store, risk, and trade-intent helpers.
- Confirm paper orders store `metadata.paperOnly = true`.
- Confirm paper fills come from deterministic `simulatePaperFill(...)`.
- Confirm order records do not depend on an external broker order id.
- Keep live broker submission code out of P7E.

## Daily Checklist

- Check dashboard state is `ready`.
- Confirm open positions have updated marks from the latest bars.
- Confirm no position has stale monitoring beyond the expected timeframe.
- Review closed trades and close reasons.
- Compare dashboard PnL against direct Postgres export.
- Confirm `PAPER_TRADING_KILL_SWITCH=false` only when new entries are allowed.
- Review risk rejections for unexpected blockers.
- Record any incident, missed bar, stale signal, or manual close.

## Weekly Review Checklist

- Export closed trades and summarize realized PnL, win rate, fees, max drawdown, and exposure time.
- Review every manual close and every stop-loss close.
- Confirm strategy, feature, and risk versions stayed stable or document version changes.
- Verify no paper positions were created without matching trade intent, order, and fill lineage.
- Verify no live broker client or credential became required.
- Review dashboard consistency against database queries.

## 30-Day Acceptance Criteria

- Paper trading runs for 30 consecutive calendar days with durable Postgres state.
- Every opened position has a persisted trade intent, paper order, deterministic fill, and position row.
- Every closed position has realized PnL, fees, close reason, and risk lineage.
- Dashboard shows open positions, closed trades, PnL, fees, and risk lineage without manual database work.
- Kill switch is tested at least once and blocks new entries without corrupting existing positions.
- No live broker order is created or required.
- No restart loses paper trading state.
- Daily checklist is completed for all trading days in the run.
- Weekly review is completed for each full week.

## Promotion Rules After 30 Days

Promotion out of paper trading requires all of the following:

- 30-day acceptance criteria are met.
- Risk rejects and kill-switch behavior are understood and documented.
- PnL export reconciles with dashboard totals.
- Operational incidents are either resolved or explicitly accepted.
- Strategy, feature, and risk version lineage is complete.
- A separate live-trading design review is completed.

Passing the paper run does not automatically enable live trading. Live execution must be a separate branch and review with explicit broker integration, operational controls, and rollback procedures.
