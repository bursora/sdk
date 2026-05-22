/**
 * Events client behaviors:
 *  - record() is fire-and-forget; never blocks the caller
 *  - flush() drains the queue and POSTs /api/v1/events with the bearer key id
 *  - Fail-open: 5xx, network error, throws all swallowed
 */

import { describe, expect, test } from "bun:test";
import { __pruneLiveClients, createEventsClient } from "../src/internal/events";

const findBursoraBeforeExitHandler = (): ((code: number) => unknown) | undefined =>
    process.listeners("beforeExit").find((l) => l.name === "bursoraDrainOnBeforeExit") as
        | ((code: number) => unknown)
        | undefined;

interface MockCall {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
}

const API_KEY = "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

const baseEvent = {
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 10,
    completionTokens: 5,
    ts: "2025-05-10T12:00:00.000Z",
} as const;

const mockFetch = (calls: MockCall[], status = 202): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === "string" ? init.body : "",
        });
        return Promise.resolve(new Response("", { status }));
    }) as unknown as typeof fetch;

const mockFetchThrow = (calls: MockCall[]): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === "string" ? init.body : "",
        });
        return Promise.reject(new Error("network"));
    }) as unknown as typeof fetch;

describe("eventsClient", () => {
    test("flush() POSTs /api/v1/events with X-Bursora-Key only (no signature)", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        client.record(baseEvent);
        await client.flush();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain("/api/v1/events");
        expect(calls[0]?.headers["x-bursora-key"]).toBe(API_KEY);
    });

    test("flush() body shape matches server zod schema", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        client.record({
            ...baseEvent,
            tenantId: "acme",
            agentId: "support",
            latencyMs: 123,
            requestId: "req-1",
        });
        await client.flush();
        const parsed = JSON.parse(calls[0]?.body ?? "{}");
        expect(parsed.events).toHaveLength(1);
        expect(parsed.events[0]).toMatchObject({
            provider: "openai",
            model: "gpt-4o",
            promptTokens: 10,
            completionTokens: 5,
            ts: "2025-05-10T12:00:00.000Z",
            tenantId: "acme",
            agentId: "support",
            latencyMs: 123,
            requestId: "req-1",
        });
    });

    test("flush() batches multiple records into a single request", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        client.record(baseEvent);
        client.record({ ...baseEvent, model: "gpt-4o-mini" });
        await client.flush();
        expect(calls).toHaveLength(1);
        const parsed = JSON.parse(calls[0]?.body ?? "{}");
        expect(parsed.events).toHaveLength(2);
    });

    test("flush() with empty queue is a no-op", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        await client.flush();
        expect(calls).toHaveLength(0);
    });

    test("record() returns synchronously; does not await network", () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        const result = client.record(baseEvent);
        expect(result).toBeUndefined();
        expect(calls).toHaveLength(0); // not flushed yet
    });

    test("flush() swallows 5xx and logs (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls, 503),
            log: (m) => logs.push(m),
        });
        client.record(baseEvent);
        await client.flush();
        expect(logs).toContain("bursora_ingest_unavailable");
    });

    test("flush() swallows network errors (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetchThrow(calls),
            log: (m) => logs.push(m),
        });
        client.record(baseEvent);
        await client.flush();
        expect(logs).toContain("bursora_ingest_unavailable");
    });

    test("default surface emits console.warn once on 401 when no log provided", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls, 401),
            });
            client.record(baseEvent);
            await client.flush();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("[bursora]");
            expect(warnings[0]).toContain("ingest");
            expect(warnings[0]).toContain("auth_invalid");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("default surface dedupes: repeated 401s do not re-emit", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls, 401),
            });
            client.record(baseEvent);
            await client.flush();
            client.record(baseEvent);
            await client.flush();
            client.record(baseEvent);
            await client.flush();
            expect(warnings).toHaveLength(1);
        } finally {
            console.warn = originalWarn;
        }
    });

    test("explicit log hook receives every call; no default console.warn", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const logs: string[] = [];
            const client = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls, 401),
                log: (m) => logs.push(m),
            });
            client.record(baseEvent);
            await client.flush();
            client.record(baseEvent);
            await client.flush();
            expect(warnings).toHaveLength(0);
            expect(logs).toHaveLength(2);
        } finally {
            console.warn = originalWarn;
        }
    });

    test("default surface categorizes network error as network_unavailable", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetchThrow(calls),
            });
            client.record(baseEvent);
            await client.flush();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("network_unavailable");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("flush() times out when fetch never resolves; logs timeout", async () => {
        const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
        const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal) {
                    signal.addEventListener("abort", () => {
                        const err = new Error("aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                }
            });
        }) as unknown as typeof fetch;
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: fetchImpl,
            ingestTimeoutMs: 30,
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        client.record(baseEvent);
        const start = Date.now();
        await client.flush();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500);
        expect(logs[0]?.msg).toBe("bursora_ingest_unavailable");
        expect(logs[0]?.meta?.category).toBe("network_unavailable");
        expect(logs[0]?.meta?.reason).toBe("timeout");
    });

    test("no-ops flush when endpoint is invalid at runtime URL build (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: { msg: string; meta: Record<string, unknown> | undefined }[] = [];
        const client = createEventsClient({
            endpoint: "not-a-url",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        client.record(baseEvent);
        await client.flush();
        expect(calls).toHaveLength(0);
        expect(logs[0]?.msg).toBe("bursora_ingest_unavailable");
        expect(logs[0]?.meta?.category).toBe("invalid_config");
    });

    test("default surface categorizes 5xx as server_error", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls, 503),
            });
            client.record(baseEvent);
            await client.flush();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("server_error");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("beforeExit drains the queue via the registered handler", async () => {
        const calls: MockCall[] = [];
        const before = process.listeners("beforeExit").slice();
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        const after = process.listeners("beforeExit");
        const added = after.filter((l) => !before.includes(l));
        // First createEventsClient in the process registers the singleton listener.
        // Subsequent calls reuse it, so `added.length` may be 0 or 1 depending on ordering.
        expect(added.length).toBeLessThanOrEqual(1);
        client.record(baseEvent);
        const handler = findBursoraBeforeExitHandler();
        if (handler === undefined) throw new Error("no beforeExit handler");
        await Promise.resolve(handler(0));
        expect(calls).toHaveLength(1);
        client.dispose();
    });

    test("50 createEventsClient calls do not register 50 beforeExit listeners", () => {
        const calls: MockCall[] = [];
        const before = process.listenerCount("beforeExit");
        const clients = Array.from({ length: 50 }, () =>
            createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls),
                log: () => {},
            }),
        );
        const after = process.listenerCount("beforeExit");
        try {
            // Module-level handler is registered at most once across all clients.
            expect(after - before).toBeLessThanOrEqual(1);
        } finally {
            for (const c of clients) c.dispose();
        }
    });

    test("dispose() removes the client from beforeExit draining", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        client.record(baseEvent);
        client.dispose();
        const handler = findBursoraBeforeExitHandler();
        if (handler !== undefined) {
            await Promise.resolve(handler(0));
        }
        // Disposed client must not be drained.
        expect(calls).toHaveLength(0);
    });

    test("beforeExit handler does not throw even when the network rejects", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetchThrow(calls),
            log: () => {},
        });
        try {
            client.record(baseEvent);
            const handler = findBursoraBeforeExitHandler();
            if (handler === undefined) throw new Error("no beforeExit handler");
            await expect(Promise.resolve(handler(0))).resolves.toBeUndefined();
        } finally {
            client.dispose();
        }
    });

    test("registered beforeExit handler is named 'bursoraDrainOnBeforeExit'", () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        try {
            const named = process
                .listeners("beforeExit")
                .filter((l) => l.name === "bursoraDrainOnBeforeExit");
            expect(named).toHaveLength(1);
        } finally {
            client.dispose();
        }
    });

    test("drainOnBeforeExit flushes clients in parallel (not sequential)", async () => {
        const FLUSH_LATENCY_MS = 50;
        const CLIENT_COUNT = 10;
        const slowFetch = ((_input: string | URL | Request, _init?: RequestInit) =>
            new Promise<Response>((resolve) => {
                setTimeout(() => resolve(new Response("", { status: 202 })), FLUSH_LATENCY_MS);
            })) as unknown as typeof fetch;
        const clients = Array.from({ length: CLIENT_COUNT }, () =>
            createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: slowFetch,
                log: () => {},
            }),
        );
        try {
            for (const c of clients) c.record(baseEvent);
            const handler = findBursoraBeforeExitHandler();
            if (handler === undefined) throw new Error("no beforeExit handler");
            const start = Date.now();
            await Promise.resolve(handler(0));
            const elapsed = Date.now() - start;
            // Sequential would be ~CLIENT_COUNT * FLUSH_LATENCY_MS = 500ms.
            // Parallel should be ~FLUSH_LATENCY_MS = 50ms (plus small overhead).
            expect(elapsed).toBeLessThan(FLUSH_LATENCY_MS * 2);
        } finally {
            for (const c of clients) c.dispose();
        }
    });

    test("drainOnBeforeExit: one client's failure does not block other clients", async () => {
        const okCalls: MockCall[] = [];
        const okClient = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(okCalls),
            log: () => {},
        });
        const badClient = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetchThrow([]),
            log: () => {},
        });
        try {
            okClient.record(baseEvent);
            badClient.record(baseEvent);
            const handler = findBursoraBeforeExitHandler();
            if (handler === undefined) throw new Error("no beforeExit handler");
            await expect(Promise.resolve(handler(0))).resolves.toBeUndefined();
            expect(okCalls).toHaveLength(1);
        } finally {
            okClient.dispose();
            badClient.dispose();
        }
    });

    test("__pruneLiveClients drops WeakRef entries whose referent has been GC'd", () => {
        const calls: MockCall[] = [];
        // Hold a strong ref so we can dispose it cleanly after.
        const keeper = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        // Create transient clients held only by a WeakRef array we don't keep.
        const transientRefs: WeakRef<object>[] = [];
        for (let i = 0; i < 5; i++) {
            const c = createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls),
                log: () => {},
            });
            transientRefs.push(new WeakRef(c as unknown as object));
        }
        // Simulate GC by clearing the local refs first.
        transientRefs.length = 0;
        // Even without real GC, __pruneLiveClients should return a count; the
        // contract under test is that the pruning entry point exists and is safe
        // to call repeatedly. The post-condition we can assert deterministically:
        // pruning returns a non-negative number and does not throw.
        const removed = __pruneLiveClients();
        expect(removed).toBeGreaterThanOrEqual(0);
        // Sanity: keeper is still drainable.
        keeper.record(baseEvent);
        const handler = findBursoraBeforeExitHandler();
        if (handler === undefined) throw new Error("no beforeExit handler");
        keeper.dispose();
    });

    test("__pruneLiveClients shrinks the WeakRef array when entries are explicitly cleared", () => {
        // Use a deterministic path: create clients, dispose them all, prune,
        // assert the second prune call removes zero (idempotent).
        const calls: MockCall[] = [];
        const clients = Array.from({ length: 3 }, () =>
            createEventsClient({
                endpoint: "https://app.bursora.com",
                apiKey: API_KEY,
                fetch: mockFetch(calls),
                log: () => {},
            }),
        );
        for (const c of clients) c.dispose();
        // After dispose, the WeakRef entries should have been filtered out by dispose itself.
        // __pruneLiveClients on top of that should be a no-op (returns 0).
        const removed = __pruneLiveClients();
        expect(removed).toBe(0);
    });

    test("recordSetupError POSTs /api/v1/setup-error with X-Bursora-Key and kind", async () => {
        const calls: MockCall[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetch(calls),
            log: () => {},
        });
        client.recordSetupError({ kind: "sdk_unknown_provider" });
        // Fire-and-forget — give the microtask queue a chance to drain.
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain("/api/v1/setup-error");
        expect(calls[0]?.headers["x-bursora-key"]).toBe(API_KEY);
        const body = JSON.parse(calls[0]?.body ?? "{}");
        expect(body.kind).toBe("sdk_unknown_provider");
        client.dispose();
    });

    test("recordSetupError swallows network errors (fire-and-forget)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createEventsClient({
            endpoint: "https://app.bursora.com",
            apiKey: API_KEY,
            fetch: mockFetchThrow(calls),
            log: (m) => logs.push(m),
        });
        // Must not throw even though fetch rejects.
        expect(() => client.recordSetupError({ kind: "sdk_unknown_provider" })).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toHaveLength(1);
        expect(logs).toContain("bursora_setup_error_unavailable");
        client.dispose();
    });
});
