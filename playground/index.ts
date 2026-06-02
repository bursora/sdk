/**
 * Bursora SDK playground.
 *
 *   bun run start              # fire calls through the wrapped mock client
 *   bun run anomaly            # seed baseline + spike, trigger anomaly cron
 *
 * Flags (both commands):
 *   --calls N                  total requests
 *   --interval Nms             delay between requests (ms)
 *   --prompt-min N             min prompt tokens per call
 *   --prompt-max N             max prompt tokens per call
 *   --completion-min N         min completion tokens per call
 *   --completion-max N         max completion tokens per call
 *
 * Only the provider HTTP call is mocked. Auth, ingest, budgets, anomaly cron
 * all run against the real local server.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function parseOptions(d: Options): Options {
    return {
        calls: num("calls", d.calls),
        interval: num("interval", d.interval),
        range: {
            promptMin: num("prompt-min", d.range.promptMin),
            promptMax: num("prompt-max", d.range.promptMax),
            completionMin: num("completion-min", d.range.completionMin),
            completionMax: num("completion-max", d.range.completionMax),
        },
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
    const res = await fetch(`${env.endpoint}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bursora-key": env.apiKey },
        body: JSON.stringify({ events: baseline }),
    });
    if (!res.ok) {
        throw new Error(`baseline ingest failed: ${res.status} ${await res.text()}`);
    }
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

function printUsage(): void {
    console.log(`usage: bun run index.ts <start|anomaly> [flags]

flags (both commands):
  --calls N              total requests          (start=${START_DEFAULTS.calls},   anomaly=${ANOMALY_DEFAULTS.calls})
  --interval Nms         delay between requests  (start=${START_DEFAULTS.interval}, anomaly=${ANOMALY_DEFAULTS.interval})
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
