import type { Env } from "./env";

export interface IngestEvent {
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
export async function ingest(env: Env, events: readonly IngestEvent[]): Promise<readonly string[]> {
    const res = await fetch(`${env.endpoint}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bursora-key": env.apiKey },
        body: JSON.stringify({ events }),
    });
    if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);

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
