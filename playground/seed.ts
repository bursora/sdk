import { log, spinner } from "@clack/prompts";
import type { Env } from "./env";
import { ingest, type IngestEvent } from "./ingest";
import { pick, type RequestRange, splitTokens } from "./usage";

export interface SeedOptions {
    readonly events: number;
    readonly days: number;
    readonly range: RequestRange;
}

export const SEED_DEFAULTS: SeedOptions = {
    events: 2_000,
    days: 30,
    range: { min: 250, max: 3_000 },
};

// Provider/model pairs litellm prices (run `bun drizzle/seed.ts` in core to
// populate the pricing table). Tenants/agents/workflows give the dashboard
// groupings something to slice by.
const MODELS: readonly { readonly provider: string; readonly model: string }[] = [
    { provider: "openai", model: "gpt-4o" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "google", model: "gemini-2.5-pro" },
];
const TENANTS = ["acme", "globex", "initech", "umbrella", "hooli"];
const AGENTS = ["support-bot", "summarizer", "code-helper", "sales-copilot"];
const WORKFLOWS = ["chat", "batch-embed", "nightly-report", "onboarding"];
const BATCH = 500;

/** Bulk-fill the dashboard with backdated events spread across the last `days`. */
export async function seed(env: Env, opts: SeedOptions): Promise<void> {
    const windowMs = opts.days * 24 * 60 * 60_000;
    const startMs = Date.now() - windowMs;
    const events: IngestEvent[] = Array.from({ length: opts.events }, () => {
        const { provider, model } = pick(MODELS);
        return {
            provider,
            model,
            region: "global",
            ...splitTokens(opts.range),
            ts: new Date(startMs + Math.floor(Math.random() * windowMs)).toISOString(),
            tenantId: pick(TENANTS),
            agentId: pick(AGENTS),
            workflowId: pick(WORKFLOWS),
        };
    });

    const s = spinner();
    s.start("ingesting events");
    const unpriced = new Set<string>();
    let sent = 0;
    for (let i = 0; i < events.length; i += BATCH) {
        for (const u of await ingest(env, events.slice(i, i + BATCH))) unpriced.add(u);
        sent = Math.min(i + BATCH, events.length);
        s.message(`ingesting ${sent}/${events.length}`);
    }
    s.stop(`sent ${sent} events across ${opts.days}d`);

    if (unpriced.size > 0) {
        log.warn(
            `unpriced, skipped (run 'bun drizzle/seed.ts' in core): ${[...unpriced].join(", ")}`,
        );
    }
    log.success(`${env.endpoint}/workspace/${env.workspaceId}/spend`);
}
