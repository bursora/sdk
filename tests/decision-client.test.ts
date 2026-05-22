/**
 * Decision client behaviors:
 *  - Calls GET /api/v1/budget with X-Bursora-Key + tenant/agent/workflow query
 *  - Returns the parsed Decision on 200
 *  - Cache hit on subsequent calls within ttl_s skips fetch
 *  - Fail-open on network error (returns null + logs)
 *  - Fail-open on 5xx
 *  - Fail-open on 4xx (treated as misconfigured but don't block consumer)
 */

import { describe, expect, test } from "bun:test";
import { createDecisionClient } from "../src/internal/decision";
import type { Decision } from "../src/types";

const ALLOW_DECISION: Decision = {
    allow: true,
    mode: "notify",
    reason: "ok",
    ttl_s: 60,
};

interface MockCall {
    readonly url: string;
    readonly headers: Record<string, string>;
}

const mockFetchOk = (body: Decision, calls: MockCall[]): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
    }) as unknown as typeof fetch;

const mockFetchStatus = (status: number, calls: MockCall[]): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return Promise.resolve(new Response("error", { status }));
    }) as unknown as typeof fetch;

const mockFetchThrow = (calls: MockCall[]): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return Promise.reject(new Error("network down"));
    }) as unknown as typeof fetch;

describe("decisionClient.fetchDecision", () => {
    test("calls GET /api/v1/budget with X-Bursora-Key only and scope params", async () => {
        const calls: MockCall[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchOk(ALLOW_DECISION, calls),
        });
        const decision = await client.fetchDecision({
            tenant_id: "acme",
            agent_id: "support",
            workflow_id: "checkout",
        });
        expect(decision).toEqual(ALLOW_DECISION);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain("/api/v1/budget");
        expect(calls[0]?.url).toContain("tenant=acme");
        expect(calls[0]?.url).toContain("agent=support");
        expect(calls[0]?.url).toContain("workflow=checkout");
        expect(calls[0]?.headers["x-bursora-key"]).toBe(
            "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        );
    });

    test("omits scope params that are not provided", async () => {
        const calls: MockCall[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchOk(ALLOW_DECISION, calls),
        });
        await client.fetchDecision({});
        expect(calls[0]?.url).not.toContain("tenant=");
        expect(calls[0]?.url).not.toContain("agent=");
        expect(calls[0]?.url).not.toContain("workflow=");
    });

    test("cache hit on second call within ttl_s skips fetch", async () => {
        const calls: MockCall[] = [];
        let now = 1_000;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => now,
            fetch: mockFetchOk(ALLOW_DECISION, calls),
        });
        await client.fetchDecision({ tenant_id: "acme" });
        now = 30_000;
        await client.fetchDecision({ tenant_id: "acme" });
        expect(calls).toHaveLength(1);
    });

    test("cache miss after ttl_s expires triggers a refetch", async () => {
        const calls: MockCall[] = [];
        let now = 1_000;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => now,
            fetch: mockFetchOk(ALLOW_DECISION, calls),
        });
        await client.fetchDecision({ tenant_id: "acme" });
        now = 1_000 + 61_000;
        await client.fetchDecision({ tenant_id: "acme" });
        expect(calls).toHaveLength(2);
    });

    test("a block decision (short ttl_s=10) expires on the SDK within its short window", async () => {
        // Asymmetric-TTL contract: when the server says ttl_s=10 on a block,
        // the SDK must refetch within ~10s so dashboard cap raises propagate
        // quickly. A long 60s TTL on the cache would keep the user blocked.
        const calls: MockCall[] = [];
        let now = 0;
        const blockDecision: Decision = {
            allow: false,
            mode: "block",
            reason: "workspace:*:over:25/10",
            ttl_s: 10,
        };
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => now,
            fetch: mockFetchOk(blockDecision, calls),
        });
        await client.fetchDecision({ tenant_id: "acme" });
        now = 5_000; // 5s: still inside short TTL, cache hit
        await client.fetchDecision({ tenant_id: "acme" });
        expect(calls).toHaveLength(1);
        now = 11_000; // 11s: short TTL expired, refetch
        await client.fetchDecision({ tenant_id: "acme" });
        expect(calls).toHaveLength(2);
    });

    test("different scopes use different cache keys", async () => {
        const calls: MockCall[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchOk(ALLOW_DECISION, calls),
        });
        await client.fetchDecision({ tenant_id: "acme" });
        await client.fetchDecision({ tenant_id: "bravo" });
        expect(calls).toHaveLength(2);
    });

    test("returns null and does not throw on 5xx (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchStatus(503, calls),
            log: (msg) => logs.push(msg),
        });
        const decision = await client.fetchDecision({});
        expect(decision).toBeNull();
        expect(logs).toContain("bursora_decision_unavailable");
    });

    test("returns null and does not throw on network error (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchThrow(calls),
            log: (msg) => logs.push(msg),
        });
        const decision = await client.fetchDecision({});
        expect(decision).toBeNull();
        expect(logs).toContain("bursora_decision_unavailable");
    });

    test("returns null on 4xx without throwing (treats as fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: mockFetchStatus(401, calls),
            log: (msg) => logs.push(msg),
        });
        const decision = await client.fetchDecision({});
        expect(decision).toBeNull();
        expect(logs).toContain("bursora_decision_unavailable");
    });

    test("default surface emits console.warn once on first 401 when no log provided", async () => {
        const calls: MockCall[] = [];
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: mockFetchStatus(401, calls),
            });
            await client.fetchDecision({});
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("[bursora]");
            expect(warnings[0]).toContain("decision");
            expect(warnings[0]).toContain("auth_invalid");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("default surface dedupes: second 401 in same process does not emit again", async () => {
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: mockFetchStatus(401, []),
            });
            await client.fetchDecision({ tenant_id: "a" });
            await client.fetchDecision({ tenant_id: "b" });
            await client.fetchDecision({ tenant_id: "c" });
            expect(warnings).toHaveLength(1);
        } finally {
            console.warn = originalWarn;
        }
    });

    test("default surface differentiates categories: 401 then 5xx emit twice", async () => {
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            let status = 401;
            const fetchImpl = ((input: string | URL | Request) => {
                void input;
                return Promise.resolve(new Response("error", { status }));
            }) as unknown as typeof fetch;
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: fetchImpl,
            });
            await client.fetchDecision({ tenant_id: "a" });
            status = 503;
            await client.fetchDecision({ tenant_id: "b" });
            expect(warnings).toHaveLength(2);
            expect(warnings[0]).toContain("auth_invalid");
            expect(warnings[1]).toContain("server_error");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("explicit log hook receives every call; no default console.warn emitted", async () => {
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const logs: string[] = [];
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: mockFetchStatus(401, []),
                log: (msg) => logs.push(msg),
            });
            await client.fetchDecision({ tenant_id: "a" });
            await client.fetchDecision({ tenant_id: "b" });
            expect(warnings).toHaveLength(0);
            expect(logs).toHaveLength(2);
            expect(logs[0]).toBe("bursora_decision_unavailable");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("default surface categorizes network error as network_unavailable", async () => {
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: mockFetchThrow([]),
            });
            await client.fetchDecision({});
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("network_unavailable");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("malformed decision (non-finite ttl_s) returns null and does not poison cache", async () => {
        const calls: MockCall[] = [];
        const logs: string[] = [];
        let bodyTtl: unknown = "sixty";
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: bodyTtl,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: (msg, meta) => logs.push(`${msg}:${meta?.category}`),
        });
        const first = await client.fetchDecision({ tenant_id: "acme" });
        expect(first).toBeNull();
        expect(logs[0]).toBe("bursora_decision_unavailable:invalid_response");
        // Next call must re-fetch — the bad body did not poison the cache.
        bodyTtl = 60;
        const second = await client.fetchDecision({ tenant_id: "acme" });
        expect(second).not.toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("malformed decision with missing fields returns null and is not cached", async () => {
        const calls: MockCall[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(JSON.stringify({ allow: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("malformed decision with wrong field types returns null and is not cached", async () => {
        const calls: MockCall[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: "yes",
                        mode: "notify",
                        reason: "ok",
                        ttl_s: 60,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("malformed decision with unknown mode returns null and is not cached", async () => {
        const calls: MockCall[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "panic",
                        reason: "ok",
                        ttl_s: 60,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(await client.fetchDecision({ tenant_id: "acme" })).toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("decision with ttl_s === 0 is returned but not cached", async () => {
        const calls: MockCall[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: 0,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
        });
        const first = await client.fetchDecision({ tenant_id: "acme" });
        expect(first).not.toBeNull();
        expect(first?.ttl_s).toBe(0);
        const second = await client.fetchDecision({ tenant_id: "acme" });
        expect(second).not.toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("decision with negative ttl_s is returned but not cached", async () => {
        const calls: MockCall[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: -10,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
        });
        const first = await client.fetchDecision({ tenant_id: "acme" });
        expect(first).not.toBeNull();
        const second = await client.fetchDecision({ tenant_id: "acme" });
        expect(second).not.toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("times out when fetch never resolves; returns null without caching", async () => {
        const calls: MockCall[] = [];
        const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
        const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
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
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            decisionTimeoutMs: 30,
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        const start = Date.now();
        const decision = await client.fetchDecision({ tenant_id: "acme" });
        const elapsed = Date.now() - start;
        expect(decision).toBeNull();
        expect(elapsed).toBeLessThan(500);
        expect(logs[0]?.msg).toBe("bursora_decision_unavailable");
        expect(logs[0]?.meta?.category).toBe("network_unavailable");
        expect(logs[0]?.meta?.reason).toBe("timeout");
        // Cache must NOT be populated; the next call should refetch.
        const decision2 = await client.fetchDecision({ tenant_id: "acme" });
        expect(decision2).toBeNull();
        expect(calls).toHaveLength(2);
    });

    test("default surface categorizes JSON parse failure as invalid_response", async () => {
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const fetchImpl = (() =>
                Promise.resolve(
                    new Response("not json{", {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                )) as unknown as typeof fetch;
            const client = createDecisionClient({
                endpoint: "https://app.bursora.com",
                apiKey: "k",
                cacheCapacity: 8,
                now: () => 0,
                fetch: fetchImpl,
            });
            await client.fetchDecision({});
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("invalid_response");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("categorizes 429 as rate_limited (separate from server_error)", async () => {
        const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
        const fetchImpl = (() =>
            Promise.resolve(
                new Response("rate limited", { status: 429 }),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        await client.fetchDecision({});
        expect(logs[0]?.meta?.category).toBe("rate_limited");
    });

    test("categorizes 503 as server_error", async () => {
        const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
        const fetchImpl = (() =>
            Promise.resolve(new Response("down", { status: 503 }))) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        await client.fetchDecision({});
        expect(logs[0]?.meta?.category).toBe("server_error");
    });

    test("categorizes 502 as server_error", async () => {
        const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
        const fetchImpl = (() =>
            Promise.resolve(
                new Response("bad gateway", { status: 502 }),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: (msg, meta) => logs.push({ msg, meta }),
        });
        await client.fetchDecision({});
        expect(logs[0]?.meta?.category).toBe("server_error");
    });

    test("decision without remainingUsd/resetAt still parses (old server)", async () => {
        const fetchImpl = (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: 60,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        const decision = await client.fetchDecision({});
        expect(decision).not.toBeNull();
        expect(decision?.remainingUsd).toBeUndefined();
        expect(decision?.resetAt).toBeUndefined();
    });

    test("decision with remainingUsd/resetAt surfaces both fields", async () => {
        const fetchImpl = (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "under:workspace:*:25/100",
                        ttl_s: 60,
                        remainingUsd: 75,
                        resetAt: "2025-05-11T00:00:00.000Z",
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        const decision = await client.fetchDecision({});
        expect(decision?.remainingUsd).toBe(75);
        expect(decision?.resetAt).toBe("2025-05-11T00:00:00.000Z");
    });

    test("decision with malformed remainingUsd is parsed without the field", async () => {
        const fetchImpl = (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: 60,
                        remainingUsd: "not-a-number",
                        resetAt: "2025-05-11T00:00:00.000Z",
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        const decision = await client.fetchDecision({});
        expect(decision).not.toBeNull();
        expect(decision?.allow).toBe(true);
        expect(decision?.remainingUsd).toBeUndefined();
        expect(decision?.resetAt).toBe("2025-05-11T00:00:00.000Z");
    });

    test("decision with malformed resetAt is parsed without the field", async () => {
        const fetchImpl = (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        allow: true,
                        mode: "notify",
                        reason: "ok",
                        ttl_s: 60,
                        remainingUsd: 50,
                        resetAt: 12345,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            )) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "https://app.bursora.com",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: () => {},
        });
        const decision = await client.fetchDecision({});
        expect(decision).not.toBeNull();
        expect(decision?.remainingUsd).toBe(50);
        expect(decision?.resetAt).toBeUndefined();
    });

    test("returns null when endpoint is invalid at runtime URL build (fail open)", async () => {
        const calls: MockCall[] = [];
        const logs: { msg: string; category: unknown }[] = [];
        const fetchImpl = ((input: string | URL | Request) => {
            calls.push({
                url: typeof input === "string" ? input : input.toString(),
                headers: {},
            });
            return Promise.resolve(new Response("", { status: 200 }));
        }) as unknown as typeof fetch;
        const client = createDecisionClient({
            endpoint: "not-a-url",
            apiKey: "k",
            cacheCapacity: 8,
            now: () => 0,
            fetch: fetchImpl,
            log: (msg, meta) => logs.push({ msg, category: meta?.category }),
        });
        const decision = await client.fetchDecision({ tenant_id: "acme" });
        expect(decision).toBeNull();
        expect(calls).toHaveLength(0);
        expect(logs[0]?.msg).toBe("bursora_decision_unavailable");
        expect(logs[0]?.category).toBe("invalid_config");
    });
});
