/**
 * Drives the real `openai` client through `wrap()`. Only the network is mocked:
 * each client gets an injected `fetch` (the shared harness's `recordingFetch`)
 * and `maxRetries: 0`, so the SDK's own request build, response parsing, error
 * classes, and stream decoding all run for real against canned JSON / SSE.
 *
 * Per-endpoint usage field names differ:
 *  - chat:       prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 *  - responses:  input_tokens / output_tokens / input_tokens_details.cached_tokens
 *  - embeddings: prompt_tokens only (no completion side)
 */

import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { BudgetExceededError } from "../../src/errors";
import type { Decision } from "../../src/types";
import { wrap } from "../../src/wrap";
import {
    buildFakeCore,
    jsonResponse,
    recordingFetch,
    sse,
    sseResponse,
    type RecordedFetchCall,
} from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

/** Real OpenAI client whose every request resolves to `body`. */
const clientReturning = (calls: RecordedFetchCall[], body: Response) =>
    new OpenAI({
        apiKey: "test",
        maxRetries: 0,
        fetch: recordingFetch(calls, () => Promise.resolve(body)),
    });

const CHAT_BODY = {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 40 },
    },
};

const RESPONSES_BODY = {
    id: "resp-1",
    object: "response",
    model: "gpt-4o",
    status: "completed",
    output: [],
    usage: {
        input_tokens: 60,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 20 },
    },
};

const EMBEDDINGS_BODY = {
    object: "list",
    model: "text-embedding-3-small",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
    usage: { prompt_tokens: 5, total_tokens: 5 },
};

const PARSE_BODY = {
    id: "chatcmpl-parsed",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: '{"x":1}' },
            finish_reason: "stop",
        },
    ],
    usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
};

describe("real openai through wrap() — only the network is mocked — non-stream", () => {
    test("chat.completions.create records one event, cache split out of prompt", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, jsonResponse(CHAT_BODY)), h.core);

        const out = await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });

        expect(out.id).toBe("chatcmpl-1");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(60);
        expect(h.events[0]?.completionTokens).toBe(7);
        expect(h.events[0]?.cacheTokens).toBe(40);
    });

    test("responses.create records one event with input/output token names", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, jsonResponse(RESPONSES_BODY)), h.core);

        const out = await wrapped.responses.create({ model: "gpt-4o", input: "hi" });

        expect(out.id).toBe("resp-1");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(40);
        expect(h.events[0]?.completionTokens).toBe(8);
        expect(h.events[0]?.cacheTokens).toBe(20);
    });

    test("embeddings.create records one event with completionTokens 0", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, jsonResponse(EMBEDDINGS_BODY)), h.core);

        const out = await wrapped.embeddings.create({
            model: "text-embedding-3-small",
            input: "hello world",
        });

        expect(out.object).toBe("list");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("text-embedding-3-small");
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("chat.completions.parse records one event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, jsonResponse(PARSE_BODY)), h.core);

        const out = await wrapped.chat.completions.parse({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "x",
                    schema: { type: "object", properties: { x: { type: "number" } } },
                },
            },
        });

        expect(out.id).toBe("chatcmpl-parsed");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(21);
        expect(h.events[0]?.completionTokens).toBe(5);
    });
});

describe("real openai through wrap() — only the network is mocked — streaming chat", () => {
    test("passes chunks through and records summed usage from the terminal chunk", async () => {
        const body = sse(
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [
                    { index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null },
                ],
            },
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [],
                usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
            },
        );
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, sseResponse(body)), h.core);

        const stream = await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: "user", content: "hi" }],
        });
        const collected: string[] = [];
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) collected.push(delta);
        }

        expect(collected).toEqual(["hi"]);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(9);
        expect(h.events[0]?.completionTokens).toBe(4);
    });

    test("early chunk reports cached_tokens, final omits usage: cache split, no negative prompt", async () => {
        const body = sse(
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [
                    { index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null },
                ],
                usage: {
                    prompt_tokens: 500,
                    completion_tokens: 0,
                    prompt_tokens_details: { cached_tokens: 100 },
                },
            },
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }],
            },
        );
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, sseResponse(body)), h.core);

        const stream = await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        for await (const _ of stream) {
            // drain
        }

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheTokens).toBe(100);
        expect(h.events[0]?.promptTokens).toBe(400);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("chunk reports only cached_tokens (no prompt_tokens): promptTokens floors at 0", async () => {
        const body = sse(
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                usage: { prompt_tokens_details: { cached_tokens: 100 } },
            },
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            },
        );
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(clientReturning(calls, sseResponse(body)), h.core);

        const stream = await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        for await (const _ of stream) {
            // drain
        }

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheTokens).toBe(100);
        expect(h.events[0]?.promptTokens).toBe(0);
    });
});

describe("real openai through wrap() — only the network is mocked — decisions, errors, passthrough", () => {
    test("block decision throws BudgetExceededError before any network call, no event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(BLOCK);
        const wrapped = wrap(clientReturning(calls, jsonResponse(CHAT_BODY)), h.core);

        await expect(
            wrapped.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider 429 surfaces a real RateLimitError, emits errored event, rethrows", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(
            clientReturning(
                calls,
                jsonResponse(
                    {
                        error: {
                            message: "nope",
                            type: "rate_limit_exceeded",
                            code: "rate_limit_exceeded",
                        },
                    },
                    429,
                ),
            ),
            h.core,
        );

        let caught: unknown;
        try {
            await wrapped.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(OpenAI.RateLimitError);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
    });

    test("provider 400 surfaces a real BadRequestError, emits errored event, rethrows", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(
            clientReturning(
                calls,
                jsonResponse(
                    {
                        error: {
                            message: "nope",
                            type: "invalid_request_error",
                            code: "invalid_request_error",
                        },
                    },
                    400,
                ),
            ),
            h.core,
        );

        let caught: unknown;
        try {
            await wrapped.responses.create({ model: "gpt-4o", input: "hi" });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(OpenAI.BadRequestError);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
    });

    test("untouched surface (models.list) passes through with no event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(
            clientReturning(calls, jsonResponse({ object: "list", data: [{ id: "gpt-4o" }] })),
            h.core,
        );

        const out = await wrapped.models.list();
        expect(out.data[0]?.id).toBe("gpt-4o");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(0);
    });

    test("wrap on an unrecognized shape throws the setup error", () => {
        const h = buildFakeCore(ALLOW);
        expect(() => wrap({} as never, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider/,
        );
    });
});
