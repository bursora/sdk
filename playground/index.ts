/**
 * Bursora SDK playground.
 *
 *   bun run start              # fire calls through the wrapped mock client
 *   bun run anomaly            # seed baseline + spike, trigger anomaly cron
 *   bun run seed               # bulk-fill the DB with backdated events
 *
 * Flags (start, anomaly):
 *   --calls N                  total requests
 *   --interval Nms             delay between requests (ms)
 *
 * Flags (seed):
 *   --events N                 total events to ingest
 *   --days N                   spread events back over N days from now
 *
 * Token-range flags (all commands):
 *   --prompt-min N             min prompt tokens per event
 *   --prompt-max N             max prompt tokens per event
 *   --completion-min N         min completion tokens per event
 *   --completion-max N         max completion tokens per event
 *
 * start/anomaly mock the provider HTTP call and run the full SDK wrap (auth,
 * preflight, ingest). seed skips the SDK and POSTs straight to the public
 * ingest endpoint in batches — fast, for populating the dashboard. Auth,
 * ingest, budgets, anomaly cron all run against the real local server.
 */

import { BudgetExceededError, createBursora, withTags, wrap } from "@bursora/sdk";
import { makeMockOpenAI, type MockUsageRange } from "./mock-clients";

interface Env {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly cronSecret: string | undefined;
    readonly workspaceId: string;
}

interface Options {
    readonly calls: number;
    readonly interval: number;
    readonly range: MockUsageRange;
}

const MODEL = "gpt-4o";
const TAGS = {
    tenant_id: "playground-tenant",
    agent_id: "playground-agent",
    workflow_id: "playground-workflow",
};
const ANOMALY_TENANT = "anomaly-demo-tenant";
const ANOMALY_AGENT = "anomaly-demo-agent";
const ANOMALY_TAGS = { tenant_id: ANOMALY_TENANT, agent_id: ANOMALY_AGENT };

const START_DEFAULTS: Options = {
    calls: 30,
    interval: 200,
    range: { promptMin: 200, promptMax: 2_500, completionMin: 50, completionMax: 800 },
};

// Sized so calls clear the anomaly detector's $1 floor on gpt-4o
// ($2.5/M input + $10/M output): ~$1/call → ~$5 spike bucket.
const ANOMALY_DEFAULTS: Options = {
    calls: 5,
    interval: 100,
    range: { promptMin: 180_000, promptMax: 220_000, completionMin: 45_000, completionMax: 55_000 },
};

interface SeedOptions {
    readonly events: number;
    readonly days: number;
    readonly range: MockUsageRange;
}

const SEED_DEFAULTS: SeedOptions = {
    events: 2_000,
    days: 30,
    range: START_DEFAULTS.range,
};

// Provider/model pairs that litellm prices (run `bun drizzle/seed.ts` in core
// to populate the pricing table). Tenants/agents/workflows give the dashboard
// groupings something to slice by.
const SEED_MODELS: readonly { readonly provider: string; readonly model: string }[] = [
    { provider: "openai", model: "gpt-4o" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "google", model: "gemini-2.5-pro" },
];
const SEED_TENANTS = ["acme", "globex", "initech", "umbrella", "hooli"];
const SEED_AGENTS = ["support-bot", "summarizer", "code-helper", "sales-copilot"];
const SEED_WORKFLOWS = ["chat", "batch-embed", "nightly-report", "onboarding"];
const SEED_BATCH = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => {
    const value = arr[rand(0, arr.length - 1)];
    if (value === undefined) throw new Error("pick: empty array");
    return value;
};

function loadEnv(): Env {
    const endpoint = process.env.BURSORA_ENDPOINT;
    const apiKey = process.env.BURSORA_API_KEY;
    if (!endpoint || !apiKey) {
        console.error("Missing BURSORA_ENDPOINT or BURSORA_API_KEY. Edit playground/.env.");
        process.exit(1);
    }
    const parts = apiKey.split("_");
    if (parts.length !== 3 || parts[0] !== "bsk" || !parts[1]) {
        console.error("BURSORA_API_KEY must match bsk_<workspaceId>_<32hex>");
        process.exit(1);
    }
    return {
        endpoint,
        apiKey,
        cronSecret: process.env.BURSORA_CRON_SECRET || undefined,
        workspaceId: parts[1],
    };
}

function flag(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function num(name: string, fallback: number): number {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.error(`--${name} must be a non-negative number`);
        process.exit(1);
    }
    return n;
}

function parseRange(d: MockUsageRange): MockUsageRange {
    return {
        promptMin: num("prompt-min", d.promptMin),
        promptMax: num("prompt-max", d.promptMax),
        completionMin: num("completion-min", d.completionMin),
        completionMax: num("completion-max", d.completionMax),
    };
}

function parseOptions(d: Options): Options {
    return {
        calls: num("calls", d.calls),
        interval: num("interval", d.interval),
        range: parseRange(d.range),
    };
}

interface Stats {
    ok: number;
    blocked: number;
    error: number;
}

async function fireBatch(
    env: Env,
    opts: Options,
    tags: Record<string, string>,
    onProgress?: (result: keyof Stats) => void,
): Promise<Stats> {
    const core = createBursora({ apiKey: env.apiKey, endpoint: env.endpoint });
    const client = wrap(makeMockOpenAI(opts.range), core);
    const stats: Stats = { ok: 0, blocked: 0, error: 0 };
    for (let i = 0; i < opts.calls; i++) {
        let result: keyof Stats = "ok";
        try {
            await withTags(tags, async () => {
                await client.chat.completions.create({ model: MODEL });
            });
        } catch (err) {
            if (err instanceof BudgetExceededError) result = "blocked";
            else {
                result = "error";
                console.error("\ncall failed:", err instanceof Error ? err.message : err);
            }
        }
        stats[result]++;
        onProgress?.(result);
        if (opts.interval > 0 && i < opts.calls - 1) await sleep(opts.interval);
    }
    await core.flush();
    return stats;
}

interface IngestEvent {
    readonly provider: string;
    readonly model: string;
    readonly region: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly ts: string;
    readonly tenantId?: string;
    readonly agentId?: string;
    readonly workflowId?: string;
}

/** POST a batch straight to the public ingest endpoint. Returns unpriced pairs. */
async function ingest(env: Env, events: readonly IngestEvent[]): Promise<readonly string[]> {
    const res = await fetch(`${env.endpoint}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bursora-key": env.apiKey },
        body: JSON.stringify({ events }),
    });
    if (!res.ok) {
        throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("unpriced" in body)) return [];
    const { unpriced } = body as { unpriced: unknown };
    if (!Array.isArray(unpriced)) return [];
    const out: string[] = [];
    for (const u of unpriced) {
        if (typeof u === "object" && u !== null && "provider" in u && "model" in u) {
            const { provider, model } = u as { provider: unknown; model: unknown };
            out.push(`${String(provider)}/${String(model)}`);
        }
    }
    return out;
}

function printOptions(label: string, opts: Options, env: Env): void {
    console.log(`▶ ${label} — calls=${opts.calls} interval=${opts.interval}ms`);
    console.log(
        `  prompt=${opts.range.promptMin}-${opts.range.promptMax}  completion=${opts.range.completionMin}-${opts.range.completionMax}`,
    );
    console.log(`  endpoint=${env.endpoint}  workspace=${env.workspaceId}`);
}

async function start(env: Env): Promise<void> {
    const opts = parseOptions(START_DEFAULTS);
    printOptions("start", opts, env);

    const stats = await fireBatch(env, opts, TAGS, (r) =>
        process.stdout.write(r === "ok" ? "." : r === "blocked" ? "B" : "!"),
    );
    process.stdout.write("\n");
    console.log(`✓ ok=${stats.ok} blocked=${stats.blocked} error=${stats.error}`);
    console.log(`  ${env.endpoint}/workspace/${env.workspaceId}/spend`);
}

async function anomaly(env: Env): Promise<void> {
    const opts = parseOptions(ANOMALY_DEFAULTS);
    printOptions("anomaly", opts, env);

    // Anomaly detector compares the current 5-min bucket against prior buckets.
    // SDK wrap() always stamps ts=now, so historical baseline can only land via
    // direct ingest — same public events endpoint the SDK uses.
    const bucketMs = 5 * 60_000;
    const nowMs = Math.floor(Date.now() / bucketMs) * bucketMs;
    const baseline = Array.from({ length: 23 }, (_, i) => {
        const jitter = 0.85 + Math.random() * 0.3;
        return {
            provider: "openai",
            model: MODEL,
            region: "global",
            promptTokens: Math.round(2_000 * jitter),
            completionTokens: Math.round(500 * jitter),
            ts: new Date(nowMs - (23 - i) * bucketMs).toISOString(),
            tenantId: ANOMALY_TENANT,
            agentId: ANOMALY_AGENT,
        };
    });
    await ingest(env, baseline);
    console.log(`  seeded ${baseline.length} backdated baseline buckets`);

    const stats = await fireBatch(env, opts, ANOMALY_TAGS);
    console.log(`  spike ok=${stats.ok} blocked=${stats.blocked} error=${stats.error}`);
    if (stats.blocked > 0) {
        console.log(`  budget blocker stopped the spike — cron will see baseline only.`);
    }

    if (!env.cronSecret) {
        console.log(`  set BURSORA_CRON_SECRET to auto-trigger anomaly scan, or:`);
        console.log(
            `    curl -H 'Authorization: Bearer <secret>' ${env.endpoint}/api/cron/anomaly`,
        );
        return;
    }
    const cronRes = await fetch(`${env.endpoint}/api/cron/anomaly`, {
        headers: { Authorization: `Bearer ${env.cronSecret}` },
    });
    console.log(`  cron status=${cronRes.status} body=${await cronRes.text()}`);
    console.log(`  ${env.endpoint}/workspace/${env.workspaceId}/alerts`);
}

async function seed(env: Env): Promise<void> {
    const events = num("events", SEED_DEFAULTS.events);
    const days = num("days", SEED_DEFAULTS.days);
    const range = parseRange(SEED_DEFAULTS.range);

    const windowMs = days * 24 * 60 * 60_000;
    const startMs = Date.now() - windowMs;
    console.log(`▶ seed — events=${events} days=${days}`);
    console.log(
        `  prompt=${range.promptMin}-${range.promptMax}  completion=${range.completionMin}-${range.completionMax}`,
    );
    console.log(`  endpoint=${env.endpoint}  workspace=${env.workspaceId}`);

    const batch: IngestEvent[] = Array.from({ length: events }, () => {
        const { provider, model } = pick(SEED_MODELS);
        return {
            provider,
            model,
            region: "global",
            promptTokens: rand(range.promptMin, range.promptMax),
            completionTokens: rand(range.completionMin, range.completionMax),
            ts: new Date(startMs + Math.floor(Math.random() * windowMs)).toISOString(),
            tenantId: pick(SEED_TENANTS),
            agentId: pick(SEED_AGENTS),
            workflowId: pick(SEED_WORKFLOWS),
        };
    });

    const unpriced = new Set<string>();
    let sent = 0;
    for (let i = 0; i < batch.length; i += SEED_BATCH) {
        const chunk = batch.slice(i, i + SEED_BATCH);
        for (const u of await ingest(env, chunk)) unpriced.add(u);
        sent += chunk.length;
        process.stdout.write(`\r  ingested ${sent}/${batch.length}`);
    }
    process.stdout.write("\n");
    if (unpriced.size > 0) {
        console.log(
            `  ⚠ unpriced, skipped (run 'bun drizzle/seed.ts' in core): ${[...unpriced].join(", ")}`,
        );
    }
    console.log(`✓ sent ${sent} events across ${days}d`);
    console.log(`  ${env.endpoint}/workspace/${env.workspaceId}/spend`);
}

function printUsage(): void {
    console.log(`usage: bun run index.ts <start|anomaly|seed> [flags]

start/anomaly:
  --calls N              total requests          (start=${START_DEFAULTS.calls},   anomaly=${ANOMALY_DEFAULTS.calls})
  --interval Nms         delay between requests  (start=${START_DEFAULTS.interval}, anomaly=${ANOMALY_DEFAULTS.interval})

seed:
  --events N             total events            (seed=${SEED_DEFAULTS.events})
  --days N               spread back over N days (seed=${SEED_DEFAULTS.days})

token ranges (all commands):
  --prompt-min N         min prompt tokens       (start=${START_DEFAULTS.range.promptMin},  anomaly=${ANOMALY_DEFAULTS.range.promptMin})
  --prompt-max N         max prompt tokens       (start=${START_DEFAULTS.range.promptMax}, anomaly=${ANOMALY_DEFAULTS.range.promptMax})
  --completion-min N     min completion tokens   (start=${START_DEFAULTS.range.completionMin},   anomaly=${ANOMALY_DEFAULTS.range.completionMin})
  --completion-max N     max completion tokens   (start=${START_DEFAULTS.range.completionMax},  anomaly=${ANOMALY_DEFAULTS.range.completionMax})
  --help, -h             show this message`);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
        printUsage();
        return;
    }
    const env = loadEnv();
    const command = argv[0];
    if (command === "start") await start(env);
    else if (command === "anomaly") await anomaly(env);
    else if (command === "seed") await seed(env);
    else {
        console.error(`unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("playground failed:", err);
    process.exit(1);
});
