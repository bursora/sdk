# Bursora SDK Playground

Three commands. `start` and `anomaly` mock the provider HTTP call and run the full SDK wrap; `seed` skips the SDK and bulk-POSTs straight to the ingest endpoint to fill the dashboard fast. Auth, ingest, budgets, and the anomaly cron all run against the real local server.

## Setup

```bash
cd playground
cp .env.example .env  # then edit
```

`.env` needs:

- `BURSORA_ENDPOINT` — local dev URL (`http://localhost:3000`)
- `BURSORA_API_KEY` — plaintext secret (`bsk_<workspaceId>_<32hex>`) from `/workspace/<id>/keys`
- `BURSORA_CRON_SECRET` — must match the server's `.env`; required to auto-trigger the anomaly cron

## Commands

```bash
bun run start      # fire calls through the wrapped mock client
bun run anomaly    # seed baseline + spike, trigger anomaly cron
bun run seed       # bulk-fill the DB with backdated events
```

## Flags

`start` / `anomaly`:

| Flag              | Default (start) | Default (anomaly) |
| ----------------- | --------------- | ----------------- |
| `--calls`         | 30              | 5                 |
| `--interval` (ms) | 200             | 100               |

`seed`:

| Flag       | Default |
| ---------- | ------- |
| `--events` | 2000    |
| `--days`   | 30      |

Token ranges (all commands):

| Flag               | Default (start/seed) | Default (anomaly) |
| ------------------ | -------------------- | ----------------- |
| `--prompt-min`     | 200                  | 180000            |
| `--prompt-max`     | 2500                 | 220000            |
| `--completion-min` | 50                   | 45000             |
| `--completion-max` | 800                  | 55000             |

`seed` spreads events randomly across the last `--days` and across a mix of tenants, agents, workflows, and models so the dashboard groupings fill out. It batches 500 events per request straight to the ingest endpoint, so 10k+ events land in seconds.

Examples:

```bash
bun run start -- --calls 100 --interval 50
bun run anomaly -- --calls 10 --prompt-max 300000
bun run seed -- --events 10000 --days 30
bun run seed -- --events 50000 --days 7 --prompt-max 8000
```

After it finishes:

- `http://localhost:3000/workspace/<id>/spend`
- `http://localhost:3000/workspace/<id>/alerts`
