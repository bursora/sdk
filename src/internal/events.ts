/** Fire-and-forget ingest of usage events. Errors are swallowed and logged. */

import { createDefaultLog, type LogFn } from "./default-log";
import { createTransport, serializeError, type HttpResult } from "./transport";

export interface EventInput {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
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

/** Top-level `flush()` is fire-and-forget; never let injected sinks reject. */
export async function safeFlush(sink: Pick<EventsClient, "flush">): Promise<void> {
    try {
        await sink.flush();
    } catch {
        // swallow
    }
}

export interface EventsClientOptions {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly fetch?: typeof fetch;
    readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
    readonly ingestTimeoutMs?: number;
}

const INGEST_UNAVAILABLE = "bursora_ingest_unavailable";
const SETUP_ERROR_UNAVAILABLE = "bursora_setup_error_unavailable";
const DEFAULT_INGEST_TIMEOUT_MS = 5000;

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

export function createEventsClient(
    opts: EventsClientOptions,
): EventsClient & { dispose: () => void; recordSetupError: (input: SetupErrorInput) => void } {
    const queue: EventInput[] = [];
    const transport = createTransport(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
    const log = opts.log ?? createDefaultLog("ingest");
    const setupErrorLog = opts.log ?? createDefaultLog("setup_error");
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

    const postJson = async (target: string, body: string, logFn: LogFn, logKey: string) => {
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
    };

    // Tracks in-flight `recordSetupError` POSTs so `flush()` (and the
    // `beforeExit` drain that wraps it) can wait for them. Short-lived
    // processes (Lambda, Workers, CLIs) would otherwise exit with the
    // setup-error POST still in transit.
    const pendingSetupErrors = new Set<Promise<void>>();

    const client: EventsClient & {
        dispose: () => void;
        recordSetupError: (input: SetupErrorInput) => void;
    } = {
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
                    await postJson(url, JSON.stringify({ events }), log, INGEST_UNAVAILABLE);
                }
            }
            if (pendingSetupErrors.size > 0) {
                await Promise.allSettled([...pendingSetupErrors]);
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
            const p = postJson(
                setupErrorUrl,
                JSON.stringify({ kind: input.kind }),
                setupErrorLog,
                SETUP_ERROR_UNAVAILABLE,
            ).catch(() => {});
            pendingSetupErrors.add(p);
            void p.finally(() => pendingSetupErrors.delete(p));
        },
        dispose(): void {
            unregisterClient(client);
        },
    };

    registerClient(client);
    return client;
}

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
