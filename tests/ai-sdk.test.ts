/**
 * bursoraMiddleware — Vercel AI SDK integration.
 *
 * Exercises the middleware hooks the way `wrapLanguageModel` calls them, with
 * fake `doGenerate`/`doStream` and a fake core. Covers: pre-call gate (block
 * throws before the model runs), usage recording on allow (generate + stream),
 * the provider-error path, tag threading, multi-step metering, and that one
 * middleware drives both v2 and v3 model shapes.
 */

import { describe, expect, test } from "bun:test";
import { bursoraMiddleware } from "../src/ai-sdk";
import { BudgetExceededError } from "../src/errors";
import { withTags } from "../src/tags";
import type { Decision } from "../src/types";
import type { BursoraCore, EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    readonly requestId?: string | null;
    readonly tenantId?: string | null;
    readonly agentId?: string | null;
    readonly workflowId?: string | null;
    readonly errored?: boolean;
}

interface DecisionCall {
    readonly tags: Record<string, string | undefined>;
    readonly intent?: { provider: string; model: string };
}

function buildCore(overrides: { decision?: Decision | null; recordThrows?: boolean } = {}) {
    const decisionCalls: DecisionCall[] = [];
    const events: RecordedEvent[] = [];
    let flushes = 0;

    const decision = {
        fetchDecision: async (
            tags: Record<string, string | undefined>,
            intent?: { provider: string; model: string },
        ): Promise<Decision | null> => {
            decisionCalls.push(intent === undefined ? { tags } : { tags, intent });
            return overrides.decision === undefined ? ALLOW : overrides.decision;
        },
    };
    const eventsClient: EventsClient = {
        record: (event: RecordedEvent): void => {
            if (overrides.recordThrows === true) throw new Error("sink exploded");
            events.push(event);
        },
        flush: async (): Promise<void> => {},
    };
    const core: BursoraCore = {
        decision,
        events: eventsClient,
        now: () => 1_000,
        flush: async (): Promise<void> => {
            flushes += 1;
        },
        dispose: () => {},
    };
    return { core, decisionCalls, events, flushes: () => flushes };
}

interface FakeModel {
    readonly specificationVersion: "v2" | "v3";
    readonly provider: string;
    readonly modelId: string;
}

function fakeModel(
    specificationVersion: "v2" | "v3",
    provider = "openai.chat",
    modelId = "gpt-4o",
): FakeModel {
    return { specificationVersion, provider, modelId };
}

function streamOf(parts: readonly unknown[]): ReadableStream<unknown> {
    return new ReadableStream<unknown>({
        start(controller): void {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    });
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
    }
    return out;
}

describe("bursoraMiddleware — wrapGenerate", () => {
    test("records usage on allow, splitting cache out of the prompt", async () => {
        const h = buildCore();
        const mw = bursoraMiddleware({ core: h.core });
        const result = {
            content: [{ type: "text", text: "hi" }],
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
            response: { id: "resp_1" },
        };
        const out = await mw.wrapGenerate({
            doGenerate: async () => result,
            model: fakeModel("v2"),
        });

        expect(out).toBe(result);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(8);
        expect(h.events[0]?.completionTokens).toBe(5);
        expect(h.events[0]?.cacheTokens).toBe(2);
        expect(h.events[0]?.requestId).toBe("resp_1");
        expect(h.events[0]?.errored).toBeFalsy();
        // intent carries the normalized slug + model id for the budget lookup
        expect(h.decisionCalls[0]?.intent).toEqual({ provider: "openai", model: "gpt-4o" });
    });

    test("throws BudgetExceededError before calling the model on a block", async () => {
        const h = buildCore({ decision: BLOCK });
        const mw = bursoraMiddleware({ core: h.core });
        let called = 0;
        await expect(
            mw.wrapGenerate({
                doGenerate: async () => {
                    called += 1;
                    return { usage: { inputTokens: 1, outputTokens: 1 } };
                },
                model: fakeModel("v2"),
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(called).toBe(0);
        expect(h.events).toHaveLength(0);
    });

    test("notify mode with allow=false does not block", async () => {
        const h = buildCore({
            decision: { allow: false, mode: "notify", reason: "warn", ttl_s: 60 },
        });
        const mw = bursoraMiddleware({ core: h.core });
        let called = 0;
        await mw.wrapGenerate({
            doGenerate: async () => {
                called += 1;
                return { usage: { inputTokens: 1, outputTokens: 1 } };
            },
            model: fakeModel("v2"),
        });
        expect(called).toBe(1);
        expect(h.events).toHaveLength(1);
    });

    test("records an errored event and rethrows the original provider error", async () => {
        const h = buildCore();
        const mw = bursoraMiddleware({ core: h.core });
        const boom = new Error("provider boom");
        await expect(
            mw.wrapGenerate({
                doGenerate: async () => {
                    throw boom;
                },
                model: fakeModel("v2"),
            }),
        ).rejects.toBe(boom);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("a throwing record sink does not mask the provider error", async () => {
        const h = buildCore({ recordThrows: true });
        const mw = bursoraMiddleware({ core: h.core });
        const boom = new Error("provider boom");
        await expect(
            mw.wrapGenerate({
                doGenerate: async () => {
                    throw boom;
                },
                model: fakeModel("v2"),
            }),
        ).rejects.toBe(boom);
    });

    test("fail-open: a null decision still calls the model", async () => {
        const h = buildCore({ decision: null });
        const mw = bursoraMiddleware({ core: h.core });
        let called = 0;
        await mw.wrapGenerate({
            doGenerate: async () => {
                called += 1;
                return { usage: { inputTokens: 1, outputTokens: 1 } };
            },
            model: fakeModel("v2"),
        });
        expect(called).toBe(1);
        expect(h.events).toHaveLength(1);
    });
});

describe("bursoraMiddleware — wrapStream", () => {
    test("passes every part through and records usage from the finish part", async () => {
        const h = buildCore();
        const mw = bursoraMiddleware({ core: h.core });
        const parts = [
            { type: "response-metadata", id: "req_9" },
            { type: "text-delta", delta: "hi" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 } },
        ];
        const out = await mw.wrapStream({
            doStream: async () => ({ stream: streamOf(parts) }),
            model: fakeModel("v2"),
        });
        const collected = await drain(out.stream);

        expect(collected).toEqual(parts);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(7);
        expect(h.events[0]?.completionTokens).toBe(3);
        expect(h.events[0]?.requestId).toBe("req_9");
        expect(h.events[0]?.errored).toBeFalsy();
    });

    test("throws BudgetExceededError before opening the stream on a block", async () => {
        const h = buildCore({ decision: BLOCK });
        const mw = bursoraMiddleware({ core: h.core });
        let called = 0;
        await expect(
            mw.wrapStream({
                doStream: async () => {
                    called += 1;
                    return { stream: streamOf([]) };
                },
                model: fakeModel("v2"),
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(called).toBe(0);
        expect(h.events).toHaveLength(0);
    });

    test("records an errored event when the underlying stream errors", async () => {
        const h = buildCore();
        const mw = bursoraMiddleware({ core: h.core });
        const stream = new ReadableStream<unknown>({
            start(controller): void {
                controller.enqueue({ type: "text-delta", delta: "hi" });
                controller.error(new Error("stream interrupted"));
            },
        });
        const out = await mw.wrapStream({
            doStream: async () => ({ stream }),
            model: fakeModel("v2"),
        });
        await expect(drain(out.stream)).rejects.toThrow("stream interrupted");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
    });
});

describe("bursoraMiddleware — v2 and v3 model shapes", () => {
    for (const version of ["v2", "v3"] as const) {
        test(`drives a ${version} model identically`, async () => {
            const h = buildCore();
            const mw = bursoraMiddleware({ core: h.core });
            await mw.wrapGenerate({
                doGenerate: async () => ({
                    usage: { inputTokens: 4, outputTokens: 2 },
                }),
                model: fakeModel(version, "anthropic.messages", "claude-sonnet-4"),
            });
            expect(h.events).toHaveLength(1);
            expect(h.events[0]?.provider).toBe("anthropic");
            expect(h.events[0]?.model).toBe("claude-sonnet-4");
            expect(h.events[0]?.promptTokens).toBe(4);
            expect(h.events[0]?.completionTokens).toBe(2);
        });
    }
});

describe("bursoraMiddleware — tag threading", () => {
    const run = async (
        opts: { closure?: Record<string, string>; providerOptions?: Record<string, unknown> },
        als?: Record<string, string>,
    ): Promise<RecordedEvent> => {
        const h = buildCore();
        const mw = bursoraMiddleware(
            opts.closure === undefined ? { core: h.core } : { core: h.core, tags: opts.closure },
        );
        const call = (): Promise<unknown> =>
            mw.wrapGenerate({
                doGenerate: async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }),
                model: fakeModel("v2"),
                ...(opts.providerOptions === undefined
                    ? {}
                    : { params: { providerOptions: { bursora: opts.providerOptions } } }),
            });
        if (als === undefined) await call();
        else await withTags(als, call);
        const event = h.events[0];
        if (event === undefined) throw new Error("no event recorded");
        return event;
    };

    test("closure tags flow into the event", async () => {
        const e = await run({ closure: { tenant_id: "closure" } });
        expect(e.tenantId).toBe("closure");
    });

    test("withTags async context overrides closure tags", async () => {
        const e = await run({ closure: { tenant_id: "closure" } }, { tenant_id: "als" });
        expect(e.tenantId).toBe("als");
    });

    test("providerOptions.bursora overrides both", async () => {
        const e = await run(
            {
                closure: { tenant_id: "closure" },
                providerOptions: { tenant_id: "po", agent_id: "support" },
            },
            { tenant_id: "als" },
        );
        expect(e.tenantId).toBe("po");
        expect(e.agentId).toBe("support");
    });

    test("non-string providerOptions tag values are ignored", async () => {
        const e = await run({ providerOptions: { tenant_id: 123, agent_id: "ok" } });
        expect(e.tenantId).toBeNull();
        expect(e.agentId).toBe("ok");
    });
});

describe("bursoraMiddleware — multi-step metering", () => {
    test("every step records, so the sum equals totalUsage", async () => {
        const h = buildCore();
        const mw = bursoraMiddleware({ core: h.core });
        const model = fakeModel("v2");
        await mw.wrapGenerate({
            doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 4 } }),
            model,
        });
        await mw.wrapGenerate({
            doGenerate: async () => ({ usage: { inputTokens: 6, outputTokens: 2 } }),
            model,
        });
        expect(h.events).toHaveLength(2);
        const totalPrompt = h.events.reduce((sum, e) => sum + e.promptTokens, 0);
        const totalCompletion = h.events.reduce((sum, e) => sum + e.completionTokens, 0);
        expect(totalPrompt).toBe(16);
        expect(totalCompletion).toBe(6);
    });
});
