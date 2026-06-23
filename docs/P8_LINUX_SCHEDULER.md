# P8 External Linux Scheduler

P8 scheduling is owned by an external Linux host. Vercel continues to host the application, dashboard, and API, but `vercel.json` does not register a Vercel Cron job.

The runtime topology is:

```text
Linux systemd timer (hourly at minute 5)
  -> GET /api/jobs/schedule
  -> Supabase jobs queue
  -> separate long-lived worker
  -> P8 pipeline and persisted dashboard state
  -> Vercel dashboard/API consumers
```

Supabase remains the durable queue and database. The scheduler only enqueues rows; it does not execute handlers or run the worker.

## Required Configuration

Set the same strong `SCHEDULER_SECRET` in both places:

1. Vercel project environment variables for the app/API deployment.
2. A root-owned environment file on the Linux scheduler host.

Create `/etc/trading-p8-scheduler.env` on the Linux host:

```text
SCHEDULER_URL=https://your-production-domain.example
SCHEDULER_SECRET=replace-with-the-same-secret-configured-in-vercel
```

Protect the file:

```bash
sudo chown root:root /etc/trading-p8-scheduler.env
sudo chmod 600 /etc/trading-p8-scheduler.env
```

Do not place the secret directly in a unit file, repository file, command history, or scheduler URL. The systemd service sends it in the `Authorization` header.

## Scheduler Service

Create `/etc/systemd/system/trading-p8-scheduler.service`:

```ini
[Unit]
Description=Enqueue the P8 hourly scheduled feed
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/trading-p8-scheduler.env
ExecStart=/usr/bin/curl --fail-with-body --silent --show-error --max-time 30 --retry 2 --header "Authorization: Bearer ${SCHEDULER_SECRET}" "${SCHEDULER_URL}/api/jobs/schedule"

[Install]
WantedBy=multi-user.target
```

The route returns a JSON summary of the six scheduled stages. A non-2xx response fails the systemd unit and appears in the journal. Scheduled dedupe keys make a retry for the same closed bar safe.

## Scheduler Timer

Create `/etc/systemd/system/trading-p8-scheduler.timer`:

```ini
[Unit]
Description=Run the P8 scheduler hourly at minute 5 UTC

[Timer]
OnCalendar=*-*-* *:05:00 UTC
Persistent=true
AccuracySec=30s
RandomizedDelaySec=0
Unit=trading-p8-scheduler.service

[Install]
WantedBy=timers.target
```

Load and start the timer:

```bash
sudo systemd-analyze verify /etc/systemd/system/trading-p8-scheduler.service
sudo systemd-analyze verify /etc/systemd/system/trading-p8-scheduler.timer
sudo systemctl daemon-reload
sudo systemctl enable --now trading-p8-scheduler.timer
systemctl list-timers trading-p8-scheduler.timer
```

Test one authenticated enqueue and inspect its logs:

```bash
sudo systemctl start trading-p8-scheduler.service
sudo systemctl status trading-p8-scheduler.service
sudo journalctl -u trading-p8-scheduler.service -n 50 --no-pager
```

## Separate Worker Service

The scheduler host does not execute queued jobs through the API route. Run the worker separately on a long-lived Linux host under a supervisor:

```bash
npm run worker:jobs -- --loop --poll-ms 5000 --lease-ms 60000
```

A minimal `/etc/systemd/system/trading-p8-worker.service` is:

```ini
[Unit]
Description=P8 durable jobs worker
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=trading
WorkingDirectory=/opt/trading
EnvironmentFile=/etc/trading-p8-worker.env
ExecStart=/usr/bin/npm run worker:jobs -- --loop --poll-ms 5000 --lease-ms 60000
Restart=always
RestartSec=5
TimeoutStopSec=75

[Install]
WantedBy=multi-user.target
```

The worker environment must contain its server-side Supabase database connection and any provider credentials required by pipeline handlers. Keep that file out of the repository and restrict it to the worker service account.

## Ownership Boundaries

- Linux/systemd owns the hourly trigger at minute 5.
- `/api/jobs/schedule` remains an authenticated enqueue-only route.
- Vercel hosts the app, API, and dashboard.
- Supabase stores the queue, job events, market state, and dashboard snapshots.
- The long-lived worker claims and executes jobs independently.
- No component in this scheduling path enables live broker or exchange execution.

## Local Fallback

The scheduler CLI remains available for local or emergency operation:

```bash
npm run scheduler:feed -- --once --dry-run
npm run scheduler:feed -- --once
```

Local dry-run behavior remains non-mutating. Production calls to `/api/jobs/schedule` should use the shared bearer secret.
