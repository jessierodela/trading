# P8E Scheduler Bootstrap

P8E starts the non-stop scheduled feed for the paper-run pipeline.

This is not tick-level streaming and it is not WebSocket ingestion. The scheduler is only a durable enqueue trigger that runs after each UTC 1h bar closes. Tick-level or WebSocket ingestion remains a later phase.

## Scheduler Mechanism

The bootstrap scheduler uses Vercel Cron:

```json
{
  "crons": [
    {
      "path": "/api/jobs/schedule",
      "schedule": "5 * * * *"
    }
  ]
}
```

The route is `GET /api/jobs/schedule`. It enqueues jobs and returns a JSON summary. It does not run handlers, import worker code, call refresh API routes, place orders, or call broker/exchange APIs.

The same scheduler service can also be called by Linux cron or a systemd timer through the CLI fallback:

```powershell
npm.cmd run scheduler:feed -- --once
npm.cmd run scheduler:feed -- --once --dry-run
```

Optional CLI arguments:

```text
--symbols BTC-USD,ETH-USD
--exchange COINBASE
--timeframe 1h
--source coinbase
--closed-bar-ts 2026-06-18T14:00:00.000Z
```

## Configuration

Defaults:

```text
SCHEDULED_FEED_SYMBOLS=BTC-USD,ETH-USD,SOL-USD,LINK-USD,AVAX-USD
SCHEDULED_FEED_EXCHANGE=COINBASE
SCHEDULED_FEED_TIMEFRAME=1h
SCHEDULED_FEED_SOURCE=coinbase
```

The scheduler currently supports the bootstrap 1h cadence only.

## Protected Route

If `SCHEDULER_SECRET` is configured, the route accepts either:

```text
Authorization: Bearer <secret>
?secret=<secret>
```

If `SCHEDULER_SECRET` is not configured, the route only accepts the Vercel Cron user-agent. In local development, `?dryRun=1` is allowed explicitly and does not require a DB connection.

Unauthorized calls return `401`. Missing DB configuration for a real enqueue returns `503`.

## Closed Bar Timing

Closed-bar calculation is UTC and never targets the currently open 1h bar. For example:

```text
now:          2026-06-18T15:05:00.000Z
closedBarTs: 2026-06-18T14:00:00.000Z
```

The closed bar timestamp is included in every scheduled dedupe key.

## Cadence

P8E provides best-effort staged scheduled enqueue. The current job queue does not provide strict dependency chaining, so this must not be read as "job B runs only after job A succeeds." Strict dependency chaining is a future enhancement.

Initial stages:

```text
market.ingest.latest     priority 10   runAfter closedBar + 5m
features.compute         priority 20   runAfter closedBar + 7m
regime.compute           priority 30   runAfter closedBar + 9m
strategies.evaluate      priority 40   runAfter closedBar + 11m
paper.monitor            priority 50   runAfter closedBar + 13m
dashboard.snapshot       priority 60   runAfter closedBar + 15m
```

Final dashboard stage payload:

```ts
{
  jobType: "dashboard.snapshot",
  snapshotType: "dashboard"
}
```

## Dedupe Strategy

Scheduled jobs are idempotent per closed bar:

```text
scheduled:market.ingest.latest:<source>:<exchange>:<timeframe>:<closedBarTs>:<symbols_csv>
scheduled:features.compute:<exchange>:<timeframe>:<closedBarTs>:<symbols_csv>:<featureVersion>
scheduled:regime.compute:<exchange>:<timeframe>:<closedBarTs>:<symbols_csv>:<regimeModelVersion>
scheduled:strategies.evaluate:<exchange>:<timeframe>:<closedBarTs>:<symbols_csv>:all
scheduled:paper.monitor:<exchange>:<timeframe>:<closedBarTs>:<symbols_csv>
scheduled:dashboard.snapshot:dashboard:<closedBarTs>
```

If the scheduler is triggered twice for the same closed bar, active queued/running jobs are reused. If a matching scheduled job already succeeded, the scheduler skips re-enqueueing that stage.

## Paper Monitor

`paper.monitor` is implemented as a paper-only handler. It reads persisted open paper positions and latest persisted bars, then updates simulated paper position mark/PnL state. It does not import broker APIs, submit live orders, add live execution job types, or call exchange order placement APIs.

## Worker Validation

Use the scheduler route or CLI to enqueue jobs, then run the worker separately:

```powershell
npm.cmd run worker:jobs -- --once
```

Inspect queue state through:

```text
GET /api/jobs/status?active=1
GET /api/jobs/status?limit=20
```

The scheduler route should return quickly because it only writes job rows. The worker owns handler execution.

## Validation

Expected local checks:

```powershell
npm.cmd exec -- tsc --noEmit --pretty false
npm.cmd run smoke:jobs
npm.cmd run smoke:pipeline-services
npm.cmd run smoke:job-worker
npm.cmd run smoke:route-jobs
npm.cmd run smoke:scheduler-bootstrap
npm.cmd run smoke:strategies
npm.cmd run smoke:backtest
npm.cmd run smoke:paper-trading
npm.cmd run build
npm.cmd run scheduler:feed -- --once --dry-run
```
