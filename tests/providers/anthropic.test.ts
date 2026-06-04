/**
 * Drives the real `@anthropic-ai/sdk` client through `wrap()`. Only the network
 * is mocked: a genuine `Anthropic` instance gets an injected constructor `fetch`
 * and `maxRetries: 0`, so the SDK's own request build, response parsing, error
 * classes, and stream decoding all run for real. This proves the wrap engine
 * survives the SDK's nested Proxy / private-field call surface and that usage
 * mapping matches the shapes Anthropic emits — non-stream JSON and named SSE
 * events. The named-SSE body is inline (provider-specific); generic builders
 * live in `_harness.ts`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../../src/errors";
import type { Decision } from "../../src/types";
import { wrap } from "../../src/wrap";
import {
    buildFakeCore,
    jsonResponse,
    recordingFetch,
    sseResponse,
    type RecordedFetchCall,
} from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };
const MODEL = "claude-3-5-sonnet-20241022";

const NON_STREAM_BODY = JSON.stringify({
    id: "msg_real_01",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
        input_tokens: 13,
        output_tokens: 9,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
    },
});

// Named SSE events: input usage on message_start, final output on message_delta.
// Each data: payload is single-line JSON; every event ends with a blank line.
const STREAM_BODY =
    `event: message_start\n` +
    `data: {"type":"message_start","message":{"id":"msg_real_stream","type":"message","role":"assistant","model":"${MODEL}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}\n\n` +
    `event: content_block_start\n` +
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
    `event: content_block_delta\n` +
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
    `event: content_block_stop\n` +
    `data: {"type":"content_block_stop","index":0}\n\n` +
    `event: message_delta\n` +
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}\n\n` +
    `event: message_stop\n` +
    `data: {"type":"message_stop"}\n\n`;

describe("real anthropic through wrap() — only the network is mocked", () => {
    test("non-stream messages.create records one event with prompt/completion/cache tokens", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch(calls, () =>
                Promise.resolve(
                    new Response(NON_STREAM_BODY, {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                ),
            ),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const out = await wrapped.messages.create({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
        });

        expect(out.id).toBe("msg_real_01");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.model).toBe(MODEL);
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
        expect(h.events[0]?.cacheTokens).toBe(500);
        // 200 of the 500 cache tokens are writes (cache_creation_input_tokens).
        expect(h.events[0]?.cacheWriteTokens).toBe(200);
    });

    test("streaming records one event summing named-SSE usage", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch(calls, () => Promise.resolve(sseResponse(STREAM_BODY))),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const stream = await wrapped.messages.create({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        });
        const collected: string[] = [];
        for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                collected.push(event.delta.text);
            }
        }

        expect(collected).toEqual(["hi"]);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.model).toBe(MODEL);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(300);
        // message_start reports cache_creation_input_tokens: 100 of the 300.
        expect(h.events[0]?.cacheWriteTokens).toBe(100);
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch(calls, () =>
                Promise.resolve(
                    new Response(NON_STREAM_BODY, {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                ),
            ),
        });
        const h = buildFakeCore(BLOCK);
        const wrapped = wrap(client, h.core);

        await expect(
            wrapped.messages.create({
                model: MODEL,
                max_tokens: 16,
                messages: [{ role: "user", content: "x" }],
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider 429 surfaces RateLimitError, emits errored event, rethrows", async () => {
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch([], () =>
                Promise.resolve(
                    jsonResponse(
                        {
                            type: "error",
                            error: { type: "rate_limit_error", message: "rate_limit_error" },
                        },
                        429,
                    ),
                ),
            ),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await expect(
            wrapped.messages.create({
                model: MODEL,
                max_tokens: 16,
                messages: [{ role: "user", content: "x" }],
            }),
        ).rejects.toBeInstanceOf(Anthropic.RateLimitError);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.provider).toBe("anthropic");
    });

    test("provider 529 surfaces an APIError, emits errored event, rethrows", async () => {
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch([], () =>
                Promise.resolve(
                    jsonResponse(
                        {
                            type: "error",
                            error: { type: "overloaded_error", message: "overloaded_error" },
                        },
                        529,
                    ),
                ),
            ),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await expect(
            wrapped.messages.create({
                model: MODEL,
                max_tokens: 16,
                messages: [{ role: "user", content: "x" }],
            }),
        ).rejects.toBeInstanceOf(Anthropic.APIError);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.provider).toBe("anthropic");
    });

    test("messages.stream() helper records one event summing named-SSE usage", async () => {
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch([], () => Promise.resolve(sseResponse(STREAM_BODY))),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const stream = wrapped.messages.stream({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
        });
        const collected: string[] = [];
        for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                collected.push(event.delta.text);
            }
        }

        expect(collected).toEqual(["hi"]);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.model).toBe(MODEL);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(300);
    });

    test("messages.stream() records usage even when consumed only via finalMessage()", async () => {
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch([], () => Promise.resolve(sseResponse(STREAM_BODY))),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const stream = wrapped.messages.stream({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
        });
        const final = await stream.finalMessage();

        expect(final.id).toBe("msg_real_stream");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(300);
    });

    test("messages.stream() returns the MessageStream untouched, not a Promise", async () => {
        const client = new Anthropic({
            apiKey: "test",
            maxRetries: 0,
            fetch: recordingFetch([], () => Promise.resolve(sseResponse(STREAM_BODY))),
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const stream = wrapped.messages.stream({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
        });

        expect(typeof stream.on).toBe("function");
        expect(typeof stream.finalMessage).toBe("function");
        expect(typeof (stream as unknown as { then?: unknown }).then).not.toBe("function");
        await stream.done();
    });
});

// Minimal stand-in for Anthropic's MessageStream: an event emitter we can drive
// synchronously, so the tap's accumulation, settle-once guard, and object
// identity are tested without the real SDK's async timing.
class FakeMessageStream {
    private readonly listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    on(event: string, listener: (...args: unknown[]) => void): this {
        (this.listeners[event] ??= []).push(listener);
        return this;
    }
    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners[event] ?? []) listener(...args);
    }
}

describe("anthropic manifest wiring — mocked clients", () => {
    test("messages.parse records one event from the response usage", async () => {
        const client = {
            messages: {
                create: async () => ({}),
                parse: async (_args: unknown) => ({
                    id: "msg_parse",
                    usage: { input_tokens: 5, output_tokens: 7 },
                }),
            },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const out = await wrapped.messages.parse({ model: MODEL, messages: [] });

        expect((out as { id: string }).id).toBe("msg_parse");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(7);
    });

    test("beta.messages.create records an event tagged anthropic", async () => {
        const client = {
            messages: { create: async () => ({}) },
            beta: {
                messages: {
                    create: async (_args: unknown) => ({
                        id: "beta_1",
                        usage: { input_tokens: 3, output_tokens: 4 },
                    }),
                },
            },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const out = await wrapped.beta.messages.create({ model: MODEL, messages: [] });

        expect((out as { id: string }).id).toBe("beta_1");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.promptTokens).toBe(3);
        expect(h.events[0]?.completionTokens).toBe(4);
    });

    test("messages.stream() taps usage and returns the stream object untouched", () => {
        const fake = new FakeMessageStream();
        const client = {
            messages: { create: async () => ({}), stream: (_args: unknown) => fake },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        const returned = wrapped.messages.stream({ model: MODEL, messages: [] });
        expect(returned).toBe(fake);

        fake.emit("streamEvent", {
            type: "message_start",
            message: {
                id: "s1",
                usage: {
                    input_tokens: 12,
                    output_tokens: 0,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 200,
                },
            },
        });
        fake.emit("streamEvent", { type: "message_delta", usage: { output_tokens: 8 } });
        fake.emit("streamEvent", { type: "message_stop" });
        expect(h.events).toHaveLength(0);

        fake.emit("end");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(300);
        expect(h.events[0]?.requestId).toBe("s1");
        expect(h.events[0]?.errored).toBeUndefined();
    });

    test("non-stream splits the 1-hour cache-write slice onto cacheWrite1hTokens", async () => {
        const client = {
            messages: {
                create: async (_args: unknown) => ({
                    id: "msg_1h",
                    usage: {
                        input_tokens: 10,
                        output_tokens: 4,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 100,
                        cache_creation: { ephemeral_1h_input_tokens: 200 },
                    },
                }),
            },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await wrapped.messages.create({ model: MODEL, messages: [] });

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheTokens).toBe(600);
        expect(h.events[0]?.cacheWriteTokens).toBe(500);
        // 200 of the 500 writes carried a 1-hour TTL.
        expect(h.events[0]?.cacheWrite1hTokens).toBe(200);
    });

    test("non-stream omits cacheWrite1hTokens when no 1-hour writes", async () => {
        const client = {
            messages: {
                create: async (_args: unknown) => ({
                    id: "msg_no1h",
                    usage: {
                        input_tokens: 10,
                        output_tokens: 4,
                        cache_creation_input_tokens: 300,
                    },
                }),
            },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await wrapped.messages.create({ model: MODEL, messages: [] });

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheWriteTokens).toBe(300);
        expect(h.events[0]?.cacheWrite1hTokens).toBeUndefined();
    });

    test("messages.stream() carries the 1-hour write slice from message_start", () => {
        const fake = new FakeMessageStream();
        const client = {
            messages: { create: async () => ({}), stream: (_args: unknown) => fake },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        wrapped.messages.stream({ model: MODEL, messages: [] });
        fake.emit("streamEvent", {
            type: "message_start",
            message: {
                id: "s1h",
                usage: {
                    input_tokens: 12,
                    output_tokens: 0,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 200,
                    cache_creation: { ephemeral_1h_input_tokens: 40 },
                },
            },
        });
        fake.emit("streamEvent", { type: "message_delta", usage: { output_tokens: 8 } });
        fake.emit("streamEvent", { type: "message_stop" });
        fake.emit("end");

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheWriteTokens).toBe(100);
        expect(h.events[0]?.cacheWrite1hTokens).toBe(40);
    });

    test("messages.stream() settles once; error then chained end records one errored event", () => {
        const fake = new FakeMessageStream();
        const client = {
            messages: { create: async () => ({}), stream: (_args: unknown) => fake },
        };
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        wrapped.messages.stream({ model: MODEL, messages: [] });
        fake.emit("streamEvent", {
            type: "message_start",
            message: { usage: { input_tokens: 5 } },
        });
        fake.emit("error");
        fake.emit("end");

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(5);
    });
});
