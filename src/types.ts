/**
 * Shared types for the @bursora/sdk surface.
 *
 * Mirrors the on-the-wire contract for the v1 SDK API. The canonical Zod
 * schemas live in the server repo and are the source of truth — these types
 * must stay byte-compatible with them:
 *
 *   - `core/app/api/v1/budget/route.ts`       — budget decision (GET response)
 *   - `core/app/api/v1/events/route.ts`       — events ingest (POST body)
 *   - `core/app/api/v1/setup-error/route.ts`  — setup error report (POST body)
 *
 * When you touch any of those route schemas, update this file in the same
 * change and ship the SDK bump. Server-side renames are not breaking unless
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
    /**
     * Subset of `cacheTokens` that are cache WRITES (Anthropic
     * `cache_creation_input_tokens`). Writes bill above base input; reads
     * (the remainder) bill below it, so the server prices the two apart.
     */
    readonly cacheWriteTokens?: number;
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
    /** Subset of `cacheTokens` that are cache writes; priced apart server-side. */
    readonly cacheWriteTokens?: number;
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
    /** Subset of `cacheTokensDelta` that are cache writes. */
    readonly cacheWriteTokensDelta?: number;
    readonly requestId?: string;
}

/**
 * Listener hooks the engine hands to an event-stream method's
 * `attachEventStream`. `onChunk` feeds one raw provider event into the usage
 * accumulator; `onSettle` is called once when the stream terminates (`errored`
 * flags an abnormal end).
 */
export interface EventStreamHooks {
    readonly onChunk: (chunk: unknown) => void;
    readonly onSettle: (errored: boolean) => void;
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
    /**
     * Set for methods that return synchronously an event-emitting stream object
     * (e.g. Anthropic's `MessageStream` from `messages.stream()`) instead of a
     * Promise. The engine invokes the method synchronously, wires usage capture
     * by handing the returned object to `attachEventStream`, and returns that
     * object untouched — preserving its `.on()` / `.finalMessage()` surface.
     * Because the request fires synchronously there is no seam to gate it, so
     * these calls are metered, not pre-blocked. Chunks decode via
     * `createStreamHandler`, same as the async stream path.
     */
    readonly attachEventStream?: (stream: object, hooks: EventStreamHooks) => void;
}

/**
 * One method on an object RETURNED by a factory call (e.g. the `Chat` from
 * `chats.create`). Unlike `MethodSpec`, the model is not in each call's args —
 * it was bound when the factory ran — so there is no `extractMeta`; the model
 * is threaded in from the factory call and `isStream` is fixed per method.
 */
export interface FactoryMethodSpec<Res = unknown, Chunk = unknown> {
    /** Method name on the returned object, e.g. "sendMessage". */
    readonly name: string;
    /** Whether this method returns a stream. */
    readonly isStream: boolean;
    /** Pull usage totals from a non-stream response. */
    readonly extractUsage: (res: Res) => UsageTotals;
    /** Optional factory returning a per-stream chunk → delta function. */
    readonly createStreamHandler?: () => (chunk: Chunk) => UsageDelta | null;
}

/**
 * A factory method (e.g. `chats.create`) that synchronously returns a stateful
 * object whose own methods must be instrumented. The model is read once from
 * the factory's args and threaded into every wrapped method on the returned
 * object. The factory call itself is not metered — only the methods it exposes.
 */
export interface FactorySpec<CreateArgs = unknown> {
    /** Dotted path to the factory method, e.g. ["chats", "create"]. */
    readonly path: readonly string[];
    /** Pull the model bound at factory time. */
    readonly extractModel: (args: CreateArgs) => string;
    /** Methods on the returned object to instrument. */
    readonly methods: readonly FactoryMethodSpec[];
}

export interface ProviderManifest {
    readonly provider: string;
    readonly methods: readonly MethodSpec[];
    /**
     * Optional factory methods whose returned object needs its own
     * instrumentation (e.g. Gemini's `chats.create` → `Chat.sendMessage`).
     */
    readonly factories?: readonly FactorySpec[];
    /**
     * Optional client-derived label overrides, resolved from the client
     * instance (not call args). Lets a provider stamp a different provider slug
     * and/or region per client — e.g. a Vertex-backed Google client labels as
     * `vertex` + its region instead of `google`. Return `{}` (or omit a field)
     * to keep the default baseURL-resolved provider and no region.
     */
    readonly resolveLabels?: (client: object) => { provider?: string; region?: string };
    /** Required. Owns the "is this client an instance of my provider?" decision. */
    readonly detect: (client: object) => boolean;
}
