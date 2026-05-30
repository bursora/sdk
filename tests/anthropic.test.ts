/**
 * Anthropic manifest behaviors via `wrap(client, core)`:
 *  - intercepts client.messages.create
 *  - non-stream: maps input_tokens / output_tokens to Usage
 *  - cache mapping: cache_creation_input_tokens + cache_read_input_tokens
 *  - block decision throws BudgetExceededError BEFORE the provider call
 *  - provider error path emits errored event and rethrows
 *  - streaming: passes the iterator through; sums usage from message_start
 *    and message_delta events
 *
 * Tests use a mock Anthropic client (we don't depend on the @anthropic-ai/sdk
 * package). Structural typing only.
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";
import { createAnthropicStreamHandler } from "../src/providers/anthropic";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface MockAnthropic {
    messages: {
        create: (args: unknown) => Promise<unknown>;
    };
}

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    readonly errored?: boolean;
}

const buildHarness = (decision: Decision | null = ALLOW) => {
    const events: RecordedEvent[] = [];
    const decisionClient: DecisionLookup = {
        fetchDecision: async () => decision,
    };
    const eventsClient: EventsClient = {
        record: (e) => events.push(e as RecordedEvent),
        flush: async () => {},
    };
    const core: BursoraCore = {
        decision: decisionClient,
        events: eventsClient,
        now: () => 1_000,
        flush: async () => {},
        dispose: () => {},
    };
    return { events, decisionClient, eventsClient, core };
};

describe("wrap(anthropic)", () => {
    test("intercepts messages.create and emits one event with input/output tokens", async () => {
        const calls: { args: unknown }[] = [];
        const h = buildHarness();
        const client: MockAnthropic = {
            messages: {
                create: async (args: unknown) => {
                    calls.push({ args });
                    return {
                        id: "msg_01",
                        type: "message",
                        model: "claude-3-5-sonnet-20241022",
                        content: [{ type: "text", text: "hi" }],
                        usage: { input_tokens: 13, output_tokens: 9 },
                    };
                },
            },
        };
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
        })) as { id: string };
        expect(out.id).toBe("msg_01");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.model).toBe("claude-3-5-sonnet-20241022");
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
    });

    test("maps cache_creation_input_tokens + cache_read_input_tokens to cacheTokens", async () => {
        const h = buildHarness();
        const client: MockAnthropic = {
            messages: {
                create: async () => ({
                    id: "msg_02",
                    model: "claude-3-5-sonnet-20241022",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 200,
                        cache_read_input_tokens: 300,
                    },
                }),
            },
        };
        const wrapped = wrap(client, h.core);
        await wrapped.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 64,
            messages: [{ role: "user", content: "x" }],
        });
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(100);
        expect(h.events[0]?.completionTokens).toBe(50);
        expect(h.events[0]?.cacheTokens).toBe(500);
    });

    test("missing cache fields default to 0", async () => {
        const h = buildHarness();
        const client: MockAnthropic = {
            messages: {
                create: async () => ({
                    id: "msg_03",
                    model: "claude-3-5-haiku-latest",
                    usage: { input_tokens: 5, output_tokens: 7 },
                }),
            },
        };
        const wrapped = wrap(client, h.core);
        await wrapped.messages.create({
            model: "claude-3-5-haiku-latest",
            max_tokens: 16,
            messages: [{ role: "user", content: "x" }],
        });
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(7);
        // cacheTokens may be undefined or 0; both indicate "no cache".
        const c = h.events[0]?.cacheTokens;
        expect(c === undefined || c === 0).toBe(true);
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        const calls: { args: unknown }[] = [];
        const h = buildHarness(BLOCK);
        const client: MockAnthropic = {
            messages: {
                create: async (args: unknown) => {
                    calls.push({ args });
                    return { id: "should-not-happen" };
                },
            },
        };
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 16,
                messages: [{ role: "user", content: "x" }],
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider error path emits errored event and rethrows", async () => {
        const h = buildHarness();
        const client: MockAnthropic = {
            messages: {
                create: async () => {
                    throw new Error("anthropic 429");
                },
            },
        };
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 16,
                messages: [{ role: "user", content: "x" }],
            }),
        ).rejects.toThrow("anthropic 429");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.provider).toBe("anthropic");
    });

    test("streaming sums tokens from message_start + message_delta events", async () => {
        const h = buildHarness();

        async function* anthropicStream() {
            yield {
                type: "message_start",
                message: {
                    id: "msg_04",
                    model: "claude-3-5-sonnet-20241022",
                    usage: { input_tokens: 12, output_tokens: 0 },
                },
            };
            yield {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            };
            yield {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hello" },
            };
            yield {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: " world" },
            };
            yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 8 },
            };
            yield { type: "message_stop" };
        }

        const client: MockAnthropic = {
            messages: {
                create: async () => anthropicStream(),
            },
        };
        const wrapped = wrap(client, h.core);
        const stream = (await wrapped.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        })) as AsyncIterable<{ type: string }>;
        const types: string[] = [];
        for await (const chunk of stream) {
            types.push(chunk.type);
        }
        expect(types).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "message_delta",
            "message_stop",
        ]);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
    });

    test("streaming treats message_delta output_tokens as cumulative, not delta", async () => {
        // Anthropic SSE emits multiple message_delta events; usage.output_tokens
        // is the running cumulative total, not an incremental delta. Three deltas
        // with totals 10, 25, 40 must end with completionTokens=40 (NOT 75).
        const h = buildHarness();
        async function* stream() {
            yield {
                type: "message_start",
                message: {
                    id: "msg_06",
                    model: "claude-3-5-sonnet-20241022",
                    usage: { input_tokens: 7, output_tokens: 0 },
                },
            };
            yield {
                type: "message_delta",
                delta: { stop_reason: null },
                usage: { output_tokens: 10 },
            };
            yield {
                type: "message_delta",
                delta: { stop_reason: null },
                usage: { output_tokens: 25 },
            };
            yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 40 },
            };
        }
        const client: MockAnthropic = {
            messages: { create: async () => stream() },
        };
        const wrapped = wrap(client, h.core);
        const iter = (await wrapped.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        })) as AsyncIterable<unknown>;
        for await (const _c of iter) void _c;
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(7);
        expect(h.events[0]?.completionTokens).toBe(40);
    });

    test("streaming captures cache tokens from message_start", async () => {
        const h = buildHarness();
        async function* stream() {
            yield {
                type: "message_start",
                message: {
                    id: "msg_05",
                    model: "claude-3-5-sonnet-20241022",
                    usage: {
                        input_tokens: 10,
                        output_tokens: 0,
                        cache_creation_input_tokens: 100,
                        cache_read_input_tokens: 200,
                    },
                },
            };
            yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 4 },
            };
        }
        const client: MockAnthropic = {
            messages: { create: async () => stream() },
        };
        const wrapped = wrap(client, h.core);
        const iter = (await wrapped.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        })) as AsyncIterable<unknown>;
        for await (const _c of iter) void _c;
        expect(h.events[0]?.promptTokens).toBe(10);
        expect(h.events[0]?.completionTokens).toBe(4);
        expect(h.events[0]?.cacheTokens).toBe(300);
    });

    test("throws at setup when client lacks any known provider shape", () => {
        const h = buildHarness();
        expect(() => wrap({} as unknown as MockAnthropic, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI or Anthropic-shaped client/,
        );
    });

    test("throws at setup when messages exists but create is not a function", () => {
        const h = buildHarness();
        const bogus = { messages: {} } as unknown as MockAnthropic;
        expect(() => wrap(bogus, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI or Anthropic-shaped client/,
        );
    });

    test("passes through untouched surface (e.g. models) without interception", async () => {
        const h = buildHarness();
        const calls: string[] = [];
        const clientWithExtras = {
            messages: {
                create: async (_args: unknown) => ({
                    usage: { input_tokens: 0, output_tokens: 0 },
                }),
            },
            models: {
                list: async () => {
                    calls.push("models.list");
                    return { data: [{ id: "claude-3-5-sonnet" }] };
                },
            },
        };
        const wrapped = wrap(clientWithExtras, h.core);
        const out = (await wrapped.models.list()) as { data: Array<{ id: string }> };
        expect(out.data[0]?.id).toBe("claude-3-5-sonnet");
        expect(calls).toEqual(["models.list"]);
        expect(h.events).toHaveLength(0);
    });

    test("stream handler is single-use: throws when a chunk arrives after message_stop", () => {
        // Guards the fragile pattern where the closure-bound handler could be
        // reused across streams. Each handler instance owns one stream.
        const handler = createAnthropicStreamHandler();
        handler({
            type: "message_start",
            message: {
                id: "msg_reuse",
                usage: { input_tokens: 4, output_tokens: 0 },
            },
        });
        handler({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 6 },
        });
        handler({ type: "message_stop" });
        expect(() => handler({ type: "message_delta", usage: { output_tokens: 99 } })).toThrow(
            /single-use/i,
        );
    });
});
