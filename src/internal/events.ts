/** Fire-and-forget ingest of usage events. Errors are swallowed and logged. */

import { createDefaultLog, type LogFn } from "./default-log";
import { createTransport, serializeError, type HttpResult } from "./transport";

/**
 * One usage event recorded into the events queue. Matches the per-record
 * shape on the wire body of `/api/v1/events`. Customers building a custom
 * `EventsQueue` receive this on `record()` and should treat it as opaque
 * (do not mutate; keep ordering).
 *
 * @public
 */
export interface EventInput {
    readonly provider: string;
    readonly model: string;
    /**
     * Provider region (e.g. a Vertex `us-central1`). Omitted for region-less
     * providers; the server defaults the stored value to `global`.
     */
    readonly region?: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    /** Subset of `cacheTokens` that are cache writes; priced apart server-side. */
    readonly cacheWriteTokens?: number;
    readonly ts: string;
    readonly tenantId?: string | null;
    readonly agentId?: string | null;
    readonly workflowId?: string | null;
    readonly latencyMs?: number | null;
    readonly requestId?: string | null;
    readonly errored?: boolean;
}

export type SetupErrorKind = "sdk_unknown_provider";

export interface SetupErrorInput {
    readonly kind: SetupErrorKind;
}

export interface EventsClient {
    record(event: EventInput): void;
    flush(): Promise<void>;
    /**
     * Best-effort report of an SDK-side setup error (e.g. wrap() can't detect
     * the provider). Optional so simple test sinks can omit it; the default
     * client implements it as a fire-and-forget POST to /api/v1/setup-error.
     */
    recordSetupError?(input: SetupErrorInput): void;
    /** Unregister from the shared `beforeExit` drain; call on HMR / teardown. Optional so test sinks can omit it. */
    dispose?(): void;
}

/**
 * Public-facing alias for `EventsClient` — the buffered batch sink that
 * `createBursora` records usage to. Same structural shape; the alias exists so
 * the public API uses "queue" terminology consistently with the docs.
 *
 * @public
 */
export type EventsQueue = EventsClient;

/**
 * Factory-built EventsClient. The SDK-built client always provides `dispose`
 * and `recordSetupError`; the base `EventsClient` keeps them optional only so
 * external/test sinks can omit them. Internal callers should accept this type
 * to skip the optional-chain dance.
 */
export type ManagedEventsClient = EventsClient &
    Required<Pick<EventsClient, "dispose" | "recordSetupError">> & {
        readonly __pendingSetupErrorsCount: () => number;
    };

/** Top-level `flush()` is fire-and-forget; never let injected sinks reject. */
export async function safeFlush(sink: Pick<EventsClient, "flush">): Promise<void> {
    try {
        await sink.flush();
    } catch {
        // swallow
    }
}

/**
 * Construction inputs for the default `EventsQueue` factory. Most callers
 * never see this — they pass `apiKey` + `endpoint` to `createBursora` and let
 * it build the default. Reach for `createEventsQueue` directly when you need
 * to inject a `fetch` implementation or tune the ingest timeout.
 *
 * @public
 */
export interface EventsClientOptions {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly fetch?: typeof fetch;
    readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
    readonly ingestTimeoutMs?: number;
    /** Test-only clock injection. Defaults to `Date.now`. */
    readonly now?: () => number;
}

const INGEST_UNAVAILABLE = "bursora_ingest_unavailable";
const INGEST_PRICING_UNKNOWN = "bursora_pricing_unknown";
const SETUP_ERROR_UNAVAILABLE = "bursora_setup_error_unavailable";
const DEFAULT_INGEST_TIMEOUT_MS = 5000;
const MAX_PENDING_SETUP_ERRORS = 256;
const PENDING_SETUP_ERROR_TTL_MS = 60 * 60 * 1000;

function logTransportFailure(log: LogFn, key: string, result: HttpResult): void {
    if (result.timedOut === true) {
        log(key, { category: "network_unavailable", reason: "timeout" });
        return;
    }
    log(key, {
        category: result.categoryOnFailure,
        ...(result.status > 0 ? { status: result.status } : {}),
    });
}

export function createEventsClient(opts: EventsClientOptions): ManagedEventsClient {
    const queue: EventInput[] = [];
    const transport = createTransport(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
    const log = opts.log ?? createDefaultLog("ingest");
    const setupErrorLog = opts.log ?? createDefaultLog("setup_error");
    const now = opts.now ?? Date.now;
    let url: string | null;
    let setupErrorUrl: string | null;
    let urlError = "";
    try {
        url = new URL("/api/v1/events", opts.endpoint).toString();
        setupErrorUrl = new URL("/api/v1/setup-error", opts.endpoint).toString();
    } catch (err) {
        url = null;
        setupErrorUrl = null;
        urlError = serializeError(err);
    }
    const timeoutMs = opts.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;

    const postJson = async (
        target: string,
        body: string,
        logFn: LogFn,
        logKey: string,
    ): Promise<HttpResult> => {
        const result = await transport.send({
            method: "POST",
            url: target,
            headers: {
                "content-type": "application/json",
                "x-bursora-key": opts.apiKey,
            },
            body,
            timeoutMs,
        });
        if (!result.ok) logTransportFailure(logFn, logKey, result);
        return result;
    };

    // The ingest endpoint accepts the batch (202) even when some events name a
    // provider/model with no pricing row: the priced events still persist and
    // the response lists the unpriced pairs. Surface them so the SDK author
    // sees which model needs a price; the priced spend is unaffected.
    const reportUnpriced = async (result: HttpResult): Promise<void> => {
        let parsed: unknown;
        try {
            parsed = await result.json();
        } catch {
            return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const unpriced = (parsed as { unpriced?: unknown }).unpriced;
        if (!Array.isArray(unpriced)) return;
        for (const entry of unpriced) {
            if (typeof entry !== "object" || entry === null) continue;
            const { provider, model } = entry as { provider?: unknown; model?: unknown };
            if (typeof provider === "string" && typeof model === "string") {
                log(INGEST_PRICING_UNKNOWN, { category: "pricing_unknown", provider, model });
            }
        }
    };

    // Tracks in-flight `recordSetupError` POSTs so `flush()` (and the
    // `beforeExit` drain that wraps it) can wait for them. Short-lived
    // processes (Lambda, Workers, CLIs) would otherwise exit with the
    // setup-error POST still in transit.
    //
    // Bounded by MAX_PENDING_SETUP_ERRORS (FIFO drop) and
    // PENDING_SETUP_ERROR_TTL_MS so long-lived processes whose POSTs hang
    // (proxy black-hole, broken egress) don't leak memory. Map preserves
    // insertion order; value is the enqueue timestamp in ms.
    const pendingSetupErrors = new Map<Promise<void>, number>();

    const evictExpiredSetupErrors = (): void => {
        const cutoff = now() - PENDING_SETUP_ERROR_TTL_MS;
        for (const [p, ts] of pendingSetupErrors) {
            if (ts > cutoff) break;
            pendingSetupErrors.delete(p);
        }
    };

    const client: ManagedEventsClient = {
        record(event: EventInput): void {
            queue.push(event);
        },
        async flush(): Promise<void> {
            if (queue.length > 0) {
                if (url === null) {
                    queue.splice(0, queue.length);
                    log(INGEST_UNAVAILABLE, { category: "invalid_config", error: urlError });
                } else {
                    const events = queue.splice(0, queue.length);
                    const result = await postJson(
                        url,
                        JSON.stringify({ events }),
                        log,
                        INGEST_UNAVAILABLE,
                    );
                    if (result.ok) await reportUnpriced(result);
                }
            }
            evictExpiredSetupErrors();
            if (pendingSetupErrors.size > 0) {
                await Promise.allSettled([...pendingSetupErrors.keys()]);
            }
        },
        recordSetupError(input: SetupErrorInput): void {
            if (setupErrorUrl === null) {
                setupErrorLog(SETUP_ERROR_UNAVAILABLE, {
                    category: "invalid_config",
                    error: urlError,
                });
                return;
            }
            evictExpiredSetupErrors();
            // Drop the oldest in-flight POST (Map preserves insertion order)
            // before adding a new one so the queue stays bounded.
            while (pendingSetupErrors.size >= MAX_PENDING_SETUP_ERRORS) {
                const oldest = pendingSetupErrors.keys().next().value;
                if (oldest === undefined) break;
                pendingSetupErrors.delete(oldest);
            }
            const p = postJson(
                setupErrorUrl,
                JSON.stringify({ kind: input.kind }),
                setupErrorLog,
                SETUP_ERROR_UNAVAILABLE,
            ).then(
                () => {},
                () => {},
            );
            pendingSetupErrors.set(p, now());
            void p.finally(() => pendingSetupErrors.delete(p));
        },
        dispose(): void {
            unregisterClient(client);
        },
        __pendingSetupErrorsCount(): number {
            return pendingSetupErrors.size;
        },
    };

    registerClient(client);
    return client;
}

/**
 * Public-facing alias for `createEventsClient`. The public API uses "queue"
 * terminology; this re-export keeps the docs and customer code consistent
 * while internal call sites continue to use `createEventsClient`.
 *
 * @public
 */
export const createEventsQueue = createEventsClient;

// Shared `beforeExit` listener + WeakRef registry so HMR / repeat-wrap cycles
// don't leak listeners and don't pin discarded clients alive for the process.
const liveClients: WeakRef<EventsClient>[] = [];
let beforeExitRegistered = false;

async function bursoraDrainOnBeforeExit(): Promise<void> {
    const snapshot: EventsClient[] = [];
    for (const ref of liveClients) {
        const c = ref.deref();
        if (c !== undefined) snapshot.push(c);
    }
    await Promise.allSettled(snapshot.map((c) => c.flush()));
}

function registerClient(client: EventsClient): void {
    liveClients.push(new WeakRef(client));
    if (beforeExitRegistered) return;
    if (typeof process === "undefined" || typeof process.on !== "function") return;
    process.on("beforeExit", bursoraDrainOnBeforeExit);
    beforeExitRegistered = true;
}

function unregisterClient(client: EventsClient): void {
    for (let i = liveClients.length - 1; i >= 0; i--) {
        const entry = liveClients[i];
        if (entry === undefined) continue;
        if (entry.deref() === client) {
            liveClients.splice(i, 1);
            return;
        }
    }
}

/** Test-only: prune GC'd WeakRef entries; lets tests assert leak-free without depending on GC timing. */
export function __pruneLiveClients(): number {
    let removed = 0;
    for (let i = liveClients.length - 1; i >= 0; i--) {
        const entry = liveClients[i];
        if (entry === undefined || entry.deref() === undefined) {
            liveClients.splice(i, 1);
            removed++;
        }
    }
    return removed;
}
