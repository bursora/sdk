# Bursora SDK Playground

Two commands. Mocks the provider HTTP call only; auth, ingest, budgets, and the anomaly cron all run against the real local server.

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
```

## Flags (both commands)

| Flag                | Default (start) | Default (anomaly) |
| ------------------- | --------------- | ----------------- |
| `--calls`           | 30              | 5                 |
| `--interval` (ms)   | 200             | 100               |
| `--prompt-min`      | 200             | 180000            |
| `--prompt-max`      | 2500            | 220000            |
| `--completion-min`  | 50              | 45000             |
| `--completion-max`  | 800             | 55000             |

Examples:

```bash
bun run start -- --calls 100 --interval 50
bun run anomaly -- --calls 10 --prompt-max 300000
```

After it finishes:

- `http://localhost:3000/workspace/<id>/spend`
- `http://localhost:3000/workspace/<id>/alerts`
