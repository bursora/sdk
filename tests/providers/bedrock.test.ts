/**
 * Drives `wrapBedrock` against a structural fake of an AWS Bedrock Runtime
 * client. No `@aws-sdk/*` dependency: the four command types are plain classes
 * whose `constructor.name` matches what the adapter dispatches on, and the fake
 * `client.send` returns canned responses shaped like the real wire output
 * (Converse `usage`, Invoke `body` as JSON bytes, the two stream bodies as
 * async iterables). Only the AWS boundary is faked; the adapter's command
 * dispatch, model-slug normalization, per-family decode, stream tap, gate, and
 * event lifecycle all run for real.
 *
 * `buildFakeCore` doubles Bursora's own backend (decisions + event sink), which
 * is the correct boundary to fake.
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../../src/errors";
import { wrapBedrock } from "../../src/providers/bedrock";
import { withTags } from "../../src/tags";
import type { Decision } from "../../src/types";
import { buildFakeCore } from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

// Plain stand-ins for the AWS command classes. The adapter only reads
// `constructor.name` and `input.modelId`, so the class name is the contract.
class ConverseCommand {
    constructor(public input: unknown) {}
}
class ConverseStreamCommand {
    constructor(public input: unknown) {}
}
class InvokeModelCommand {
    constructor(public input: unknown) {}
}
class InvokeModelWithResponseStreamCommand {
    constructor(public input: unknown) {}
}

type SendFn = (command: unknown) => Promise<unknown>;

/** Minimal client surface: `send` plus inert fields a real client carries. */
function fakeClient(send: SendFn): { send: SendFn; config: object } {
    return { send, config: {} };
}

const encode = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

async function* asyncOf<T>(...items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
}

const invokeChunks = (...objs: unknown[]) =>
    asyncOf(...objs.map((o) => ({ chunk: { bytes: encode(o) } })));

describe("wrapBedrock — Converse (non-stream)", () => {
    test("records normalized usage; cache split out; provider=bedrock; region prefix stripped", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                output: { message: { role: "assistant", content: [{ text: "hi" }] } },
                usage: {
                    inputTokens: 13,
                    outputTokens: 9,
                    cacheReadInputTokens: 300,
                    cacheWriteInputTokens: 200,
                },
            })),
            h.core,
        );

        const res = (await client.send(
            new ConverseCommand({ modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" }),
        )) as { usage: { inputTokens: number } };

        expect(res.usage.inputTokens).toBe(13);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("bedrock");
        expect(h.events[0]?.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
        expect(h.events[0]?.cacheTokens).toBe(500);
        expect(h.events[0]?.cacheWriteTokens).toBe(200);
        expect(h.events[0]?.errored).toBeFalsy();
    });

    test("block decision throws BudgetExceededError before send; no event", async () => {
        const h = buildFakeCore(BLOCK);
        let sent = false;
        const client = wrapBedrock(
            fakeClient(async () => {
                sent = true;
                return { usage: { inputTokens: 1, outputTokens: 1 } };
            }),
            h.core,
        );

        let caught: unknown;
        try {
            await client.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0" }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(BudgetExceededError);
        expect(sent).toBe(false);
        expect(h.events).toHaveLength(0);
    });

    test("send error records an errored event and rethrows the original", async () => {
        const h = buildFakeCore(ALLOW);
        const boom = new Error("throttled");
        const client = wrapBedrock(
            fakeClient(async () => {
                throw boom;
            }),
            h.core,
        );

        let caught: unknown;
        try {
            await client.send(new ConverseCommand({ modelId: "meta.llama3-1-8b-instruct-v1:0" }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(boom);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });
});

describe("wrapBedrock — InvokeModel (non-stream) per-family decode", () => {
    test("anthropic body: cache read+write summed, prompt excludes cache, requestId from id", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: encode({
                    id: "msg_bedrock_1",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "text", text: "hi" }],
                    usage: {
                        input_tokens: 13,
                        output_tokens: 9,
                        cache_creation_input_tokens: 200,
                        cache_read_input_tokens: 300,
                    },
                }),
            })),
            h.core,
        );

        await client.send(
            new InvokeModelCommand({ modelId: "anthropic.claude-3-haiku-20240307-v1:0" }),
        );

        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
        expect(h.events[0]?.cacheTokens).toBe(500);
        expect(h.events[0]?.cacheWriteTokens).toBe(200);
        expect(h.events[0]?.requestId).toBe("msg_bedrock_1");
    });

    test("meta body: prompt_token_count / generation_token_count", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: encode({
                    generation: "hi",
                    prompt_token_count: 18,
                    generation_token_count: 6,
                    stop_reason: "stop",
                }),
            })),
            h.core,
        );

        await client.send(new InvokeModelCommand({ modelId: "meta.llama3-1-405b-instruct-v1:0" }));

        expect(h.events[0]?.promptTokens).toBe(18);
        expect(h.events[0]?.completionTokens).toBe(6);
        expect(h.events[0]?.cacheTokens).toBeUndefined();
    });

    test("amazon Titan body: inputTextTokenCount + summed result tokenCount", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: encode({
                    inputTextTokenCount: 7,
                    results: [
                        { tokenCount: 4, outputText: "a" },
                        { tokenCount: 5, outputText: "b" },
                    ],
                }),
            })),
            h.core,
        );

        await client.send(new InvokeModelCommand({ modelId: "amazon.titan-text-express-v1" }));

        expect(h.events[0]?.promptTokens).toBe(7);
        expect(h.events[0]?.completionTokens).toBe(9);
    });

    test("amazon Nova body: usage object (Converse field names)", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: encode({
                    output: { message: { content: [{ text: "hi" }] } },
                    usage: { inputTokens: 11, outputTokens: 4 },
                }),
            })),
            h.core,
        );

        await client.send(new InvokeModelCommand({ modelId: "amazon.nova-lite-v1:0" }));

        expect(h.events[0]?.promptTokens).toBe(11);
        expect(h.events[0]?.completionTokens).toBe(4);
    });

    test("mistral body: no token counts on the invoke wire — records 0/0 but still gates", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: encode({ outputs: [{ text: "hi", stop_reason: "stop" }] }),
            })),
            h.core,
        );

        await client.send(new InvokeModelCommand({ modelId: "mistral.mistral-large-2407-v1:0" }));

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });
});

describe("wrapBedrock — ConverseStream", () => {
    test("passes events through; records usage from the metadata event", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                stream: asyncOf(
                    { messageStart: { role: "assistant" } },
                    { contentBlockDelta: { delta: { text: "hi" } } },
                    { messageStop: { stopReason: "end_turn" } },
                    {
                        metadata: {
                            usage: {
                                inputTokens: 20,
                                outputTokens: 8,
                                cacheReadInputTokens: 100,
                            },
                        },
                    },
                ),
            })),
            h.core,
        );

        const res = (await client.send(
            new ConverseStreamCommand({ modelId: "anthropic.claude-3-5-haiku-20241022-v1:0" }),
        )) as { stream: AsyncIterable<unknown> };

        const seen: unknown[] = [];
        for await (const ev of res.stream) seen.push(ev);

        expect(seen).toHaveLength(4); // every event delivered untouched
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(20);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(100);
    });
});

describe("wrapBedrock — InvokeModelWithResponseStream", () => {
    test("anthropic stream: per-family decode, prompt + cumulative output + cache", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: invokeChunks(
                    {
                        type: "message_start",
                        message: {
                            id: "msg_stream_1",
                            usage: {
                                input_tokens: 12,
                                output_tokens: 0,
                                cache_creation_input_tokens: 50,
                                cache_read_input_tokens: 30,
                            },
                        },
                    },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
                    { type: "message_delta", usage: { output_tokens: 7 } },
                    {
                        type: "message_stop",
                        "amazon-bedrock-invocationMetrics": {
                            inputTokenCount: 12,
                            outputTokenCount: 7,
                        },
                    },
                ),
            })),
            h.core,
        );

        const res = (await client.send(
            new InvokeModelWithResponseStreamCommand({
                modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
            }),
        )) as { body: AsyncIterable<unknown> };

        let count = 0;
        for await (const _ of res.body) count++;

        expect(count).toBe(4);
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(7);
        expect(h.events[0]?.cacheTokens).toBe(80);
        expect(h.events[0]?.cacheWriteTokens).toBe(50);
        expect(h.events[0]?.requestId).toBe("msg_stream_1");
    });

    test("titan stream: no per-chunk usage — invocationMetrics backstop supplies counts", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: invokeChunks(
                    { outputText: "h", index: 0 },
                    { outputText: "i", index: 1 },
                    {
                        outputText: "",
                        completionReason: "FINISH",
                        "amazon-bedrock-invocationMetrics": {
                            inputTokenCount: 15,
                            outputTokenCount: 22,
                        },
                    },
                ),
            })),
            h.core,
        );

        const res = (await client.send(
            new InvokeModelWithResponseStreamCommand({
                modelId: "amazon.titan-text-express-v1",
            }),
        )) as { body: AsyncIterable<unknown> };
        for await (const _ of res.body) void _;

        expect(h.events[0]?.promptTokens).toBe(15);
        expect(h.events[0]?.completionTokens).toBe(22);
    });

    test("meta stream: counts arrive on the terminal chunk", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: invokeChunks(
                    { generation: "h", stop_reason: null },
                    {
                        generation: "i",
                        stop_reason: "stop",
                        prompt_token_count: 9,
                        generation_token_count: 3,
                        "amazon-bedrock-invocationMetrics": {
                            inputTokenCount: 9,
                            outputTokenCount: 3,
                        },
                    },
                ),
            })),
            h.core,
        );

        const res = (await client.send(
            new InvokeModelWithResponseStreamCommand({
                modelId: "meta.llama3-1-70b-instruct-v1:0",
            }),
        )) as { body: AsyncIterable<unknown> };
        for await (const _ of res.body) void _;

        expect(h.events[0]?.promptTokens).toBe(9);
        expect(h.events[0]?.completionTokens).toBe(3);
    });

    test("breaking out of the stream early still records once", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({
                body: invokeChunks(
                    { outputText: "h" },
                    {
                        "amazon-bedrock-invocationMetrics": {
                            inputTokenCount: 5,
                            outputTokenCount: 1,
                        },
                    },
                ),
            })),
            h.core,
        );

        const res = (await client.send(
            new InvokeModelWithResponseStreamCommand({ modelId: "amazon.titan-text-lite-v1" }),
        )) as { body: AsyncIterable<unknown> };
        for await (const _ of res.body) break;

        expect(h.events).toHaveLength(1);
    });
});

describe("wrapBedrock — dispatch + plumbing", () => {
    test("unknown command passes through untouched and unmetered", async () => {
        const h = buildFakeCore(BLOCK);
        class ListFoundationModelsCommand {
            constructor(public input: unknown) {}
        }
        const client = wrapBedrock(
            fakeClient(async () => ({ modelSummaries: [] })),
            h.core,
        );

        const res = await client.send(new ListFoundationModelsCommand({}));

        expect(res).toEqual({ modelSummaries: [] });
        expect(h.events).toHaveLength(0); // not gated, not recorded
    });

    test("eu./apac. inference-profile prefixes are stripped too", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({ usage: { inputTokens: 1, outputTokens: 1 } })),
            h.core,
        );

        await client.send(
            new ConverseCommand({ modelId: "eu.anthropic.claude-3-5-sonnet-20240620-v1:0" }),
        );
        await client.send(new ConverseCommand({ modelId: "apac.amazon.nova-pro-v1:0" }));

        expect(h.events[0]?.model).toBe("anthropic.claude-3-5-sonnet-20240620-v1:0");
        expect(h.events[1]?.model).toBe("amazon.nova-pro-v1:0");
    });

    test("exposes the .budget headroom snapshot, like wrap()", async () => {
        const h = buildFakeCore({
            allow: true,
            mode: "notify",
            reason: "ok",
            ttl_s: 60,
            remainingUsd: 4.25,
            resetAt: "2026-07-01T00:00:00.000Z",
        });
        const client = wrapBedrock(
            fakeClient(async () => ({ usage: { inputTokens: 1, outputTokens: 1 } })),
            h.core,
        );

        expect(client.budget).toBeNull(); // no decision fetched yet
        await client.send(new ConverseCommand({ modelId: "amazon.nova-micro-v1:0" }));
        expect(client.budget).toEqual({ remainingUsd: 4.25, resetAt: "2026-07-01T00:00:00.000Z" });
    });

    test("threads withTags context onto the recorded event", async () => {
        const h = buildFakeCore(ALLOW);
        const client = wrapBedrock(
            fakeClient(async () => ({ usage: { inputTokens: 2, outputTokens: 2 } })),
            h.core,
        );

        await withTags({ tenant_id: "acme", agent_id: "bot" }, () =>
            client.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0" })),
        );

        expect(h.events[0]?.tenantId).toBe("acme");
        expect(h.events[0]?.agentId).toBe("bot");
    });
});
