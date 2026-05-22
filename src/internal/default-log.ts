/** Default log: one `console.warn` per failure category for the process lifetime. */

export type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export function createDefaultLog(component: "decision" | "ingest" | "setup_error"): LogFn {
    const seen = new Set<string>();
    return (_msg: string, meta?: Record<string, unknown>): void => {
        const category = meta?.category;
        if (typeof category !== "string") return;
        if (seen.has(category)) return;
        seen.add(category);
        console.warn(
            `[bursora] ${component} unavailable: ${category} (subsequent occurrences suppressed)`,
        );
    };
}
