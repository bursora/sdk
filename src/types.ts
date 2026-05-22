/**
 * Shared types for the @bursora/sdk surface.
 *
 * Mirrors the on-the-wire contract from `app/api/v1/budget/route.ts` and
 * `app/api/v1/events/route.ts`. Server-side renames are not breaking unless
 * the JSON body shape changes.
 */

export type BudgetMode = "notify" | "throttle" | "block";

/**
 * SDK-facing budget decision.
 *
 * `remainingUsd` and `resetAt` are a read-only headroom snapshot from the
 * strictest applicable budget (or winning trip row on the over-cap path).
 * Both are optional so the SDK still parses responses from older servers that
 * never emit them; the server may also omit them (or send the empty-string
 * `resetAt` sentinel) when no budgets apply.
 */
export interface Decision {
    readonly allow: boolean;
    readonly mode: BudgetMode;
    readonly reason: string;
    readonly ttl_s: number;
    readonly remainingUsd?: number;
    readonly resetAt?: string;
}

/**
 * Read-only headroom snapshot exposed on `wrap(client).budget`. Mirrors the
 * `remainingUsd` / `resetAt` pair from the most recent decision the SDK
 * could fully validate.
 *
 * Last-known-good semantic: once set, a later decision that omits the fields
 * leaves the prior snapshot in place. Customers polling between calls never
 * see the value flicker back to `null` mid-process.
 */
export interface BudgetSnapshot {
    readonly remainingUsd: number;
    readonly resetAt: string;
}

export interface Tags {
    readonly tenant_id?: string;
    readonly agent_id?: string;
    readonly workflow_id?: string;
}

export interface Usage {
    readonly provider: string;
    readonly model: string;
    readonly region?: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    readonly latencyMs?: number;
    readonly requestId?: string;
}

/**
 * Per-call usage totals extracted by a provider manifest. The wrapper owns
 * provider/model/latency/region; extractors return only what they read from
 * the response body.
 */
export interface UsageTotals {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    readonly requestId?: string;
}

/**
 * Per-chunk usage delta emitted by a stream handler. The generic wrap engine
 * sums deltas across the stream and records the total at completion.
 */
export interface UsageDelta {
    readonly promptTokensDelta: number;
    readonly completionTokensDelta: number;
    readonly cacheTokensDelta?: number;
    readonly requestId?: string;
}

/**
 * Declarative description of a single provider method to instrument. The
 * generic `wrap()` engine reads a ProviderManifest and produces a Proxy that
 * routes every described method through the standard call lifecycle (decision
 * lookup, event emission, error path, stream handling).
 */
export interface MethodSpec<Args = unknown, Res = unknown, Chunk = unknown> {
    /** Dotted path on the client, e.g. ["chat", "completions", "create"]. */
    readonly path: readonly string[];
    /** When true, missing path on the target is ignored instead of erroring. */
    readonly optional?: boolean;
    /** Pull provider/model + stream flag from call arguments. */
    readonly extractMeta: (args: Args) => { model: string; isStream: boolean };
    /** Pull usage totals from a non-stream response. */
    readonly extractUsage: (res: Res) => UsageTotals;
    /** Optional factory returning a per-stream chunk → delta function. */
    readonly createStreamHandler?: () => (chunk: Chunk) => UsageDelta | null;
}

export interface ProviderManifest {
    readonly provider: string;
    readonly methods: readonly MethodSpec[];
    /** Required. Owns the "is this client an instance of my provider?" decision. */
    readonly detect: (client: object) => boolean;
}
