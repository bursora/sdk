/**
 * HttpTransport behaviors:
 *  - Forwards method/url/headers/body to the injected fetch
 *  - Returns ok=true with status and a working json() on 2xx
 *  - Returns ok=false with categorized status on HTTP error (401/429/5xx)
 *  - Returns ok=false with category 'network_unavailable' on fetch throw
 *  - Returns ok=false with category 'network_unavailable' and timedOut=true on AbortError
 *  - Aborts the underlying fetch when timeoutMs elapses
 *  - Never throws synchronously or via the returned promise
 */

import { describe, expect, test } from "bun:test";
import { createTransport } from "../src/internal/transport";

interface MockCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | undefined;
}

const recordingFetch = (
    calls: MockCall[],
    impl: (call: MockCall, init?: RequestInit) => Promise<Response>,
): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        const call: MockCall = {
            url: typeof input === "string" ? input : input.toString(),
            method: init?.method ?? "GET",
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === "string" ? init.body : undefined,
        };
        calls.push(call);
        return impl(call, init);
    }) as unknown as typeof fetch;

describe("createTransport", () => {
    test("forwards method, url, headers, body to fetch and returns ok+status+json", async () => {
        const calls: MockCall[] = [];
        const transport = createTransport({
            fetch: recordingFetch(calls, () =>
                Promise.resolve(
                    new Response(JSON.stringify({ hello: "world" }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                ),
            ),
        });
        const result = await transport.send({
            method: "POST",
            url: "https://app.bursora.com/api/v1/events",
            headers: { "x-bursora-key": "k", "content-type": "application/json" },
            body: '{"events":[]}',
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ hello: "world" });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("POST");
        expect(calls[0]?.url).toBe("https://app.bursora.com/api/v1/events");
        expect(calls[0]?.headers["x-bursora-key"]).toBe("k");
        expect(calls[0]?.body).toBe('{"events":[]}');
    });

    test("returns ok=false with category 'auth_invalid' on 401", async () => {
        const transport = createTransport({
            fetch: (() =>
                Promise.resolve(new Response("", { status: 401 }))) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(401);
        expect(result.categoryOnFailure).toBe("auth_invalid");
    });

    test("returns ok=false with category 'rate_limited' on 429", async () => {
        const transport = createTransport({
            fetch: (() =>
                Promise.resolve(new Response("", { status: 429 }))) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(429);
        expect(result.categoryOnFailure).toBe("rate_limited");
    });

    test("returns ok=false with category 'server_error' on 5xx", async () => {
        const transport = createTransport({
            fetch: (() =>
                Promise.resolve(new Response("", { status: 503 }))) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(503);
        expect(result.categoryOnFailure).toBe("server_error");
    });

    test("returns ok=false with category 'network_unavailable' on fetch throw", async () => {
        const transport = createTransport({
            fetch: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(0);
        expect(result.categoryOnFailure).toBe("network_unavailable");
        expect(result.timedOut).toBeFalsy();
    });

    test("aborts and marks timedOut when fetch never resolves within timeoutMs", async () => {
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
        const transport = createTransport({ fetch: fetchImpl });
        const start = Date.now();
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 30,
        });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500);
        expect(result.ok).toBe(false);
        expect(result.status).toBe(0);
        expect(result.categoryOnFailure).toBe("network_unavailable");
        expect(result.timedOut).toBe(true);
    });

    test("never throws; resolves even when fetch rejects with non-Error", async () => {
        const transport = createTransport({
            fetch: (() => Promise.reject("boom")) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(0);
        expect(result.categoryOnFailure).toBe("network_unavailable");
    });

    test("result.json() surfaces parse errors to the caller", async () => {
        const transport = createTransport({
            fetch: (() =>
                Promise.resolve(
                    new Response("not json{", {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                )) as unknown as typeof fetch,
        });
        const result = await transport.send({
            method: "GET",
            url: "https://app.bursora.com/x",
            headers: {},
            timeoutMs: 1000,
        });
        expect(result.ok).toBe(true);
        await expect(result.json()).rejects.toBeDefined();
    });

    test("uses globalThis.fetch when no fetch override is provided", async () => {
        const original = globalThis.fetch;
        let called = false;
        globalThis.fetch = (() => {
            called = true;
            return Promise.resolve(new Response("", { status: 204 }));
        }) as unknown as typeof fetch;
        try {
            const transport = createTransport({});
            const result = await transport.send({
                method: "GET",
                url: "https://app.bursora.com/x",
                headers: {},
                timeoutMs: 1000,
            });
            expect(called).toBe(true);
            expect(result.status).toBe(204);
        } finally {
            globalThis.fetch = original;
        }
    });
});
