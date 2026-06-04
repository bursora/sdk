# Bursora SDK Playground

One command, an interactive wizard. Pick a mode, fill in the values (defaults pre-filled, enter to accept), and it runs.

```bash
bun run start
```

Two modes:

- **seed** — bulk-fill the dashboard with backdated events. POSTs straight to the ingest endpoint in batches, so 10k+ events land in seconds. Spread across a mix of tenants, agents, workflows, and models so the dashboard groupings fill out.
- **anomaly** — seed a low backdated baseline, fire a spike through the full SDK wrap, then wait for the in-process anomaly cron (every 5 min) to raise the alert.

Auth, ingest, budgets, and the anomaly cron all run against the real local server.

## Setup

```bash
cd playground
cp .env.example .env  # then edit
```

`.env` needs:

- `BURSORA_ENDPOINT` — local dev URL (`http://localhost:3000`)
- `BURSORA_API_KEY` — plaintext secret (`bsk_<workspaceId>_<32hex>`) from `/workspace/<id>/keys`

## Values

| Value                  | Mode    | Default | Meaning                                       |
| ---------------------- | ------- | ------- | --------------------------------------------- |
| events                 | seed    | 2000    | total events to ingest                        |
| days                   | seed    | 30      | spread events back over N days                |
| spike calls            | anomaly | 5       | requests fired through the SDK wrap           |
| delay between calls    | anomaly | 100     | ms between spike calls                        |
| min/max tokens/request | both    | varies  | request size band; bigger band, costlier call |

`min/max tokens per request` sets how big each request is, which sets its cost. Defaults are small for `seed` (250–3000) and large for `anomaly` (300k–400k) so the spike clears the detector's per-call floor.

After it finishes:

- `http://localhost:3000/workspace/<id>/spend`
- `http://localhost:3000/workspace/<id>/alerts`
