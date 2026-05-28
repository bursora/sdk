/** Default log: one `console.warn` per failure category for the process lifetime. */

export type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export function createDefaultLog(component: "decision" | "ingest" | "setup_error"): LogFn {
    const seen = new Set<string>();
    return (_msg: string, meta?: Record<string, unknown>): void => {
        const category = meta?.category;
        if (typeof category !== "string") return;
        // Unpriced models are informational, not an outage: the call succeeded
        // and priced spend was recorded. Print the offending model and dedup
        // per provider/model so distinct gaps each surface once.
        if (category === "pricing_unknown") {
            const provider = typeof meta?.provider === "string" ? meta.provider : "?";
            const model = typeof meta?.model === "string" ? meta.model : "?";
            const key = `pricing_unknown:${provider}/${model}`;
            if (seen.has(key)) return;
            seen.add(key);
            console.warn(
                `[bursora] ${component}: no pricing for ${provider}/${model}; its spend isn't tracked until you add a price (subsequent occurrences suppressed)`,
            );
            return;
        }
        if (seen.has(category)) return;
        seen.add(category);
        console.warn(
            `[bursora] ${component} unavailable: ${category} (subsequent occurrences suppressed)`,
        );
    };
}
