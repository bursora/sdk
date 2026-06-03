import { BudgetExceededError, createBursora, withTags, wrap } from "@bursora/sdk";
import { log, spinner } from "@clack/prompts";
import type { Env } from "./env";
import { ingest, type IngestEvent } from "./ingest";
import { makeMockOpenAI, type RequestRange, sleep } from "./usage";

export interface AnomalyOptions {
    readonly calls: number;
    readonly interval: number;
    readonly range: RequestRange;
}

// Spike sized to clear the detector's $1/call floor on gpt-4o
// ($2.5/M input + $10/M output): ~300k+ tokens/call -> ~$1.2+/call.
export const ANOMALY_DEFAULTS: AnomalyOptions = {
    calls: 5,
    interval: 100,
    range: { min: 300_000, max: 400_000 },
};

const MODEL = "gpt-4o";
const TENANT = "anomaly-demo-tenant";
const AGENT = "anomaly-demo-agent";
const TAGS = { tenant_id: TENANT, agent_id: AGENT };
const BASELINE_BUCKETS = 23;
const BUCKET_MS = 5 * 60_000;

/** Seed a low backdated baseline, fire a spike through the SDK, trigger the cron. */
export async function anomaly(env: Env, opts: AnomalyOptions): Promise<void> {
    // The detector compares the current 5-min bucket against prior buckets.
    // wrap() always stamps ts=now, so the baseline can only land via direct
    // ingest — same endpoint the SDK uses.
    const nowMs = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const baseline: IngestEvent[] = Array.from({ length: BASELINE_BUCKETS }, (_, i) => {
        const jitter = 0.85 + Math.random() * 0.3;
        return {
            provider: "openai",
            model: MODEL,
            region: "global",
            promptTokens: Math.round(2_000 * jitter),
            completionTokens: Math.round(500 * jitter),
            ts: new Date(nowMs - (BASELINE_BUCKETS - i) * BUCKET_MS).toISOString(),
            tenantId: TENANT,
            agentId: AGENT,
        };
    });

    const s = spinner();
    s.start("seeding baseline");
    await ingest(env, baseline);

    const core = createBursora({ apiKey: env.apiKey, endpoint: env.endpoint });
    const client = wrap(makeMockOpenAI(opts.range), core);
    let ok = 0;
    let blocked = 0;
    for (let i = 0; i < opts.calls; i++) {
        s.message(`firing spike ${i + 1}/${opts.calls}`);
        try {
            await withTags(TAGS, () => client.chat.completions.create({ model: MODEL }));
            ok++;
        } catch (err) {
            if (!(err instanceof BudgetExceededError)) throw err;
            blocked++;
        }
        if (opts.interval > 0 && i < opts.calls - 1) await sleep(opts.interval);
    }
    await core.flush();
    s.stop(`baseline + spike sent (ok=${ok} blocked=${blocked})`);
    if (blocked > 0) log.warn("budget blocker stopped the spike — cron will see baseline only");

    if (!env.cronSecret) {
        log.info("set BURSORA_CRON_SECRET to auto-trigger /api/cron/anomaly");
        return;
    }
    const res = await fetch(`${env.endpoint}/api/cron/anomaly`, {
        headers: { Authorization: `Bearer ${env.cronSecret}` },
    });
    log.step(`cron ${res.status}: ${await res.text()}`);
    log.success(`${env.endpoint}/workspace/${env.workspaceId}/alerts`);
}
