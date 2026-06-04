/**
 * Batch metering helpers. Batch jobs report usage at results-fetch, not submit,
 * so these record (never gate) one `batch: true` event per succeeded result.
 *
 *  - `meterAnthropicBatch` consumes the async iterable from
 *    `messages.batches.results()`; only `succeeded` entries carry usage.
 *  - `meterOpenAIBatch` parses the batch output JSONL; each line's
 *    `response.body` carries the model + usage, chat or responses shaped.
 */

import { describe, expect, test } from "bun:test";
import { meterAnthropicBatch, meterOpenAIBatch } from "../src/batch";
import { buildFakeCore } from "./_harness";

async function* asIterable<T>(items: readonly T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

const anthropicLine = (
    type: string,
    message?: Record<string, unknown>,
): Record<string, unknown> => ({
    custom_id: "req-1",
    result: message === undefined ? { type } : { type, message },
});

describe("meterAnthropicBatch", () => {
    test("records one batch event per succeeded result with per-entry model + cache split", async () => {
        const h = buildFakeCore(null);
        await meterAnthropicBatch(
            h.core,
            asIterable([
                anthropicLine("succeeded", {
                    id: "msg_1",
                    model: "claude-3-5-sonnet-20241022",
                    usage: {
                        input_tokens: 13,
                        output_tokens: 9,
                        cache_creation_input_tokens: 200,
                        cache_read_input_tokens: 300,
                    },
                }),
                anthropicLine("succeeded", {
                    id: "msg_2",
                    model: "claude-3-5-haiku-20241022",
                    usage: { input_tokens: 5, output_tokens: 7 },
                }),
            ]),
        );

        expect(h.events).toHaveLength(2);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.batch).toBe(true);
        expect(h.events[0]?.model).toBe("claude-3-5-sonnet-20241022");
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
        expect(h.events[0]?.cacheTokens).toBe(500);
        expect(h.events[0]?.cacheWriteTokens).toBe(200);
        expect(h.events[0]?.requestId).toBe("msg_1");

        expect(h.events[1]?.model).toBe("claude-3-5-haiku-20241022");
        expect(h.events[1]?.batch).toBe(true);
        expect(h.events[1]?.cacheTokens).toBeUndefined();
        expect(h.events[1]?.cacheWriteTokens).toBeUndefined();
    });

    test("skips errored, canceled, and expired results", async () => {
        const h = buildFakeCore(null);
        await meterAnthropicBatch(
            h.core,
            asIterable([
                anthropicLine("errored"),
                anthropicLine("canceled"),
                anthropicLine("expired"),
                anthropicLine("succeeded", {
                    model: "claude-3-5-sonnet-20241022",
                    usage: { input_tokens: 1, output_tokens: 2 },
                }),
            ]),
        );

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(1);
    });

    test("applies tags to every recorded event", async () => {
        const h = buildFakeCore(null);
        await meterAnthropicBatch(
            h.core,
            asIterable([
                anthropicLine("succeeded", {
                    model: "claude-3-5-sonnet-20241022",
                    usage: { input_tokens: 1, output_tokens: 1 },
                }),
            ]),
            { tags: { tenant_id: "cust-7", agent_id: "agent-a", workflow_id: "wf-x" } },
        );

        expect(h.events[0]?.tenantId).toBe("cust-7");
        expect(h.events[0]?.agentId).toBe("agent-a");
        expect(h.events[0]?.workflowId).toBe("wf-x");
    });
});

describe("meterOpenAIBatch", () => {
    const chatLine = (model: string, usage: Record<string, unknown>): string =>
        JSON.stringify({
            custom_id: "req-1",
            response: { status_code: 200, body: { model, usage } },
        });

    test("records one batch event per output line, excluding cached input from prompt", async () => {
        const h = buildFakeCore(null);
        const output = [
            chatLine("gpt-4o-mini", {
                prompt_tokens: 100,
                completion_tokens: 40,
                prompt_tokens_details: { cached_tokens: 30 },
            }),
            chatLine("gpt-4o", { prompt_tokens: 10, completion_tokens: 5 }),
        ].join("\n");

        await meterOpenAIBatch(h.core, output);

        expect(h.events).toHaveLength(2);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.batch).toBe(true);
        expect(h.events[0]?.model).toBe("gpt-4o-mini");
        expect(h.events[0]?.promptTokens).toBe(70); // 100 - 30 cached
        expect(h.events[0]?.completionTokens).toBe(40);
        expect(h.events[0]?.cacheTokens).toBe(30);
        expect(h.events[1]?.promptTokens).toBe(10);
        expect(h.events[1]?.cacheTokens).toBeUndefined();
    });

    test("maps the responses-endpoint usage shape (input_tokens/output_tokens)", async () => {
        const h = buildFakeCore(null);
        const output = JSON.stringify({
            custom_id: "req-1",
            response: {
                status_code: 200,
                body: {
                    model: "gpt-4.1",
                    usage: {
                        input_tokens: 50,
                        output_tokens: 12,
                        input_tokens_details: { cached_tokens: 20 },
                    },
                },
            },
        });

        await meterOpenAIBatch(h.core, output);

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(30); // 50 - 20 cached
        expect(h.events[0]?.completionTokens).toBe(12);
        expect(h.events[0]?.cacheTokens).toBe(20);
    });

    test("skips blank lines and error rows without a body", async () => {
        const h = buildFakeCore(null);
        const output = [
            "",
            JSON.stringify({ custom_id: "req-1", response: null, error: { message: "boom" } }),
            "   ",
            chatLine("gpt-4o-mini", { prompt_tokens: 3, completion_tokens: 1 }),
            "{ not json",
        ].join("\n");

        await meterOpenAIBatch(h.core, output);

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.model).toBe("gpt-4o-mini");
        expect(h.events[0]?.promptTokens).toBe(3);
    });

    test("no events recorded for an empty output file", async () => {
        const h = buildFakeCore(null);
        await meterOpenAIBatch(h.core, "");
        expect(h.events).toHaveLength(0);
    });
});
