/**
 * createBursora — single shared owner of decision cache + events queue.
 *
 * Behaviors:
 *   - constructor wires decision + events + now
 *   - flush() drains the shared events queue
 *   - dispose() removes events client from beforeExit drain
 *   - two wrappers sharing one BursoraCore share the same queue:
 *     core.flush() drains events recorded across all wrapped clients
 *   - caller-supplied DecisionClient is honored (default not constructed)
 *   - caller-supplied EventsQueue is honored (default not constructed)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBursora } from "../src/bursora";
import {
    createDecisionClient as createDecisionClientPublic,
    createEventsQueue as createEventsQueuePublic,
} from "../src/index";
import type { DecisionClient } from "../src/internal/decision";
import { __pruneLiveClients, type EventsClient } from "../src/internal/events";
import type { Decision } from "../src/types";
import { wrap } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };

const API_KEY = "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const ENDPOINT = "https://app.bursora.com";

let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

function stubFetch(impl: typeof fetch): void {
    globalThis.fetch = impl;
}

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    console.warn = () => {};
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
});

describe("createBursora — wiring", () => {
    test("returns a core with decision, events, now, flush, dispose", () => {
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        expect(typeof core.decision.fetchDecision).toBe("function");
        expect(typeof core.events.record).toBe("function");
        expect(typeof core.events.flush).toBe("function");
        expect(typeof core.now).toBe("function");
        expect(typeof core.flush).toBe("function");
        expect(typeof core.dispose).toBe("function");
        expect(core.now()).toBeGreaterThan(0);
        core.dispose();
    });
});

describe("createBursora — flush()", () => {
    test("flush() POSTs queued events to /api/v1/events", async () => {
        const fetchCalls: string[] = [];
        stubFetch(((url: string | URL | Request) => {
            fetchCalls.push(typeof url === "string" ? url : url.toString());
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch);
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        core.events.record({
            provider: "openai",
            model: "gpt-4o",
            promptTokens: 1,
            completionTokens: 1,
            ts: "2026-05-13T00:00:00.000Z",
        });
        await core.flush();
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]).toContain("/api/v1/events");
        core.dispose();
    });

    test("flush() swallows transport errors", async () => {
        stubFetch((async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch);
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        core.events.record({
            provider: "openai",
            model: "gpt-4o",
            promptTokens: 1,
            completionTokens: 1,
            ts: "2026-05-13T00:00:00.000Z",
        });
        await expect(core.flush()).resolves.toBeUndefined();
        core.dispose();
    });
});

describe("createBursora — dispose()", () => {
    test("dispose() removes events client from beforeExit drain", async () => {
        __pruneLiveClients();
        const fetchCalls: string[] = [];
        stubFetch(((url: string | URL | Request) => {
            fetchCalls.push(typeof url === "string" ? url : url.toString());
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch);
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        core.events.record({
            provider: "openai",
            model: "gpt-4o",
            promptTokens: 1,
            completionTokens: 1,
            ts: "2026-05-13T00:00:00.000Z",
        });
        core.dispose();
        const handler = process
            .listeners("beforeExit")
            .find((l) => l.name === "bursoraDrainOnBeforeExit") as
            | ((code: number) => unknown)
            | undefined;
        if (handler !== undefined) await Promise.resolve(handler(0));
        expect(fetchCalls).toHaveLength(0);
    });
});

describe("createBursora — clock injection", () => {
    test("uses the injected clock instead of Date.now()", () => {
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);
        let ticks = 0;
        const clock = (): number => {
            ticks += 1;
            return 42_000 + ticks;
        };
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT, clock });
        expect(core.now()).toBe(42_001);
        expect(core.now()).toBe(42_002);
        core.dispose();
    });

    test("default clock reflects post-construction reassignment of globalThis.Date.now", () => {
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);
        const originalDateNow = Date.now;
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            Date.now = () => 7_777_777;
            expect(core.now()).toBe(7_777_777);
        } finally {
            Date.now = originalDateNow;
        }
        core.dispose();
    });
});

describe("createBursora — shared queue across wrappers", () => {
    test("two wrappers sharing one core drain through a single flush() call", async () => {
        const fetchCalls: { url: string; body: string }[] = [];
        stubFetch(((url: string | URL | Request, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.includes("/api/v1/events")) {
                fetchCalls.push({ url: u, body: String(init?.body ?? "") });
            }
            if (u.includes("/api/v1/budget")) {
                return Promise.resolve(
                    new Response(JSON.stringify(ALLOW), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch);

        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });

        const openaiClient = {
            chat: {
                completions: {
                    create: async (_args: unknown) => ({
                        id: "c1",
                        model: "gpt-4o",
                        usage: { prompt_tokens: 1, completion_tokens: 1 },
                    }),
                },
            },
            embeddings: { create: async (_args: unknown) => ({}) },
        };
        const anthropicClient = {
            messages: {
                create: async (_args: unknown) => ({
                    id: "m1",
                    model: "claude-3-5-sonnet-20241022",
                    usage: { input_tokens: 2, output_tokens: 2 },
                }),
            },
        };

        const wOpenAI = wrap(openaiClient, core);
        const wAnthropic = wrap(anthropicClient, core);

        await wOpenAI.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });
        await wAnthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
        });

        await core.flush();

        const allBodies = fetchCalls.map((c) => c.body).join("");
        expect(allBodies).toContain('"provider":"openai"');
        expect(allBodies).toContain('"provider":"anthropic"');

        core.dispose();
    });

    test("wrap(client, core) does not create a new events queue", () => {
        __pruneLiveClients();
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);
        const core = createBursora({ apiKey: API_KEY, endpoint: ENDPOINT });
        const client = {
            chat: {
                completions: { create: async (_args: unknown) => ({ usage: {} }) },
            },
            embeddings: { create: async (_args: unknown) => ({}) },
        };
        wrap(client, core);
        wrap(client, core);
        wrap(client, core);

        core.dispose();
        expect(__pruneLiveClients()).toBe(0);
    });
});

describe("createBursora — custom adapters", () => {
    test("caller-supplied DecisionClient is honored; default decision factory is not constructed", async () => {
        // No fetch stub — if the default DecisionClient ever runs, its first
        // HTTP call would throw against the real network and fail this test.
        const fetchCalls: string[] = [];
        stubFetch(((url: string | URL | Request) => {
            fetchCalls.push(typeof url === "string" ? url : url.toString());
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch);

        const decisionCalls: Decision[] = [];
        const customDecision: DecisionClient = {
            fetchDecision: async () => {
                const d: Decision = { allow: true, mode: "notify", reason: "custom", ttl_s: 1 };
                decisionCalls.push(d);
                return d;
            },
        };

        const core = createBursora({
            apiKey: API_KEY,
            endpoint: ENDPOINT,
            decision: customDecision,
        });

        expect(core.decision).toBe(customDecision);

        const result = await core.decision.fetchDecision({ tenant_id: "acme" });
        expect(result?.reason).toBe("custom");
        expect(decisionCalls).toHaveLength(1);
        // The default decision client would have hit /api/v1/budget.
        expect(fetchCalls.some((u) => u.includes("/api/v1/budget"))).toBe(false);

        core.dispose();
    });

    test("caller-supplied EventsQueue is honored; default events factory is not constructed", async () => {
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);

        const recorded: { provider: string; model: string }[] = [];
        let flushCalls = 0;
        const customEvents: EventsClient = {
            record: (e) => {
                recorded.push({ provider: e.provider, model: e.model });
            },
            flush: async () => {
                flushCalls += 1;
            },
        };

        const core = createBursora({
            apiKey: API_KEY,
            endpoint: ENDPOINT,
            events: customEvents,
        });

        expect(core.events).toBe(customEvents);

        core.events.record({
            provider: "openai",
            model: "gpt-4o",
            promptTokens: 1,
            completionTokens: 1,
            ts: "2026-05-13T00:00:00.000Z",
        });
        expect(recorded).toEqual([{ provider: "openai", model: "gpt-4o" }]);

        await core.flush();
        expect(flushCalls).toBe(1);

        // dispose() must not throw even though the custom sink has no
        // `dispose` method.
        expect(() => core.dispose()).not.toThrow();
    });

    test("public factories createDecisionClient + createEventsQueue compose into createBursora", async () => {
        // Customer-visible composition: build adapters independently with the
        // public factories from the SDK entry, then hand them to createBursora.
        expect(typeof createDecisionClientPublic).toBe("function");
        expect(typeof createEventsQueuePublic).toBe("function");

        const fetchCalls: string[] = [];
        stubFetch(((url: string | URL | Request) => {
            fetchCalls.push(typeof url === "string" ? url : url.toString());
            return Promise.resolve(
                new Response(JSON.stringify(ALLOW), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as unknown as typeof fetch);

        const decision = createDecisionClientPublic({
            apiKey: API_KEY,
            endpoint: ENDPOINT,
            cacheCapacity: 8,
            now: () => 0,
        });
        const events = createEventsQueuePublic({
            apiKey: API_KEY,
            endpoint: ENDPOINT,
        });
        const core = createBursora({ decision, events });

        expect(core.decision).toBe(decision);
        expect(core.events).toBe(events);

        // Sanity: a fetchDecision call goes through the caller-built client.
        const d = await core.decision.fetchDecision({ tenant_id: "acme" });
        expect(d).toEqual(ALLOW);

        core.dispose();
    });
});
