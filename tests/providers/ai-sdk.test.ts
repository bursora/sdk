/**
 * Drives the REAL Vercel AI SDK provider adapters through `bursoraMiddleware`. A
 * genuine `@ai-sdk/openai` (and one `@ai-sdk/anthropic`) model is built with an
 * injected `fetch`, wrapped by the real `wrapLanguageModel` + the real
 * `bursoraMiddleware`, and driven by real `generateText`/`streamText`. ONLY the
 * network is mocked: every request stops at the `fetch` boundary (canned JSON /
 * SSE), so the adapter's own request building, response parsing, V2 usage
 * mapping, error classes, and stream decoding all run for real. No model-object
 * mock; `ai/test` is not used.
 *
 * The OpenAI model uses `.chat("gpt-4o")` — provider id `"openai.chat"`, wire =
 * Chat Completions (`prompt_tokens`/`completion_tokens`/
 * `prompt_tokens_details.cached_tokens`). The adapter parses these into V2
 * `inputTokens`/`outputTokens`/`cachedInputTokens`; the middleware then maps to
 * `promptTokens`/`completionTokens`/`cacheTokens` and normalizes the provider
 * slug to `"openai"`.
 *
 * `buildFakeCore` doubles the budgeting backend (decisions + event sink) — that
 * is Bursora's own boundary, correct to fake; the AI provider is not.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
    APICallError,
    embed,
    embedMany,
    generateImage,
    generateText,
    stepCountIs,
    streamText,
    tool,
    wrapEmbeddingModel,
    wrapImageModel,
    wrapLanguageModel,
} from "ai";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { BudgetExceededError } from "../../src/errors";
import {
    bursoraEmbeddingMiddleware,
    bursoraImageMiddleware,
    bursoraMiddleware,
} from "../../src/providers/ai-sdk";
import { withTags } from "../../src/tags";
import type { Decision } from "../../src/types";
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

/** Real OpenAI Chat Completions model whose network is the supplied `fetch`. */
const openaiChat = (fetchImpl: typeof fetch) =>
    createOpenAI({ apiKey: "test", fetch: fetchImpl }).chat("gpt-4o");

/** Wrap a real adapter with the real `wrapLanguageModel` + real middleware. */
function wrapped(
    model: ReturnType<typeof openaiChat>,
    core: ReturnType<typeof buildFakeCore>["core"],
    tags?: Record<string, string>,
) {
    return wrapLanguageModel({
        model,
        middleware:
            tags === undefined ? bursoraMiddleware({ core }) : bursoraMiddleware({ core, tags }),
    });
}

const CHAT_BODY = {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 40 },
    },
};

describe("real openai adapter through bursoraMiddleware — only the network is mocked — wrapGenerate", () => {
    test("records usage on allow: cache split out of prompt, response.id captured, provider/model normalized", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const model = wrapped(
            openaiChat(recordingFetch(calls, () => Promise.resolve(jsonResponse(CHAT_BODY)))),
            h.core,
        );

        const out = await generateText({ model, prompt: "hi" });

        expect(out.text).toBe("hi");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(60);
        expect(h.events[0]?.completionTokens).toBe(7);
        expect(h.events[0]?.cacheTokens).toBe(40);
        expect(h.events[0]?.requestId).toBe("chatcmpl-1");
        expect(h.events[0]?.errored).toBeFalsy();
    });

    test("block decision throws BudgetExceededError before any network call; no event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(BLOCK);
        const model = wrapped(
            openaiChat(recordingFetch(calls, () => Promise.resolve(jsonResponse(CHAT_BODY)))),
            h.core,
        );

        await expect(generateText({ model, prompt: "hi" })).rejects.toBeInstanceOf(
            BudgetExceededError,
        );
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider 429 surfaces a real APICallError, records an errored event, rethrows", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        // 429 is retryable; maxRetries: 0 stops the adapter from wrapping it in a
        // retry error, so the single canned response surfaces as a bare APICallError.
        const model = wrapped(
            openaiChat(
                recordingFetch(calls, () =>
                    Promise.resolve(
                        jsonResponse(
                            {
                                error: {
                                    message: "boom",
                                    type: "rate_limit_exceeded",
                                    code: "rate_limit_exceeded",
                                },
                            },
                            429,
                        ),
                    ),
                ),
            ),
            h.core,
        );

        let caught: unknown;
        try {
            await generateText({ model, prompt: "hi", maxRetries: 0 });
        } catch (e) {
            caught = e;
        }

        expect(APICallError.isInstance(caught)).toBe(true);
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("a throwing record sink does not mask the provider error", async () => {
        const h = buildFakeCore(ALLOW);
        const core = {
            ...h.core,
            events: {
                record: () => {
                    throw new Error("sink exploded");
                },
                flush: async () => {},
            },
        };
        const model = wrapLanguageModel({
            model: openaiChat(
                recordingFetch([], () =>
                    Promise.resolve(
                        jsonResponse(
                            {
                                error: {
                                    message: "boom",
                                    type: "rate_limit_exceeded",
                                    code: "rate_limit_exceeded",
                                },
                            },
                            429,
                        ),
                    ),
                ),
            ),
            middleware: bursoraMiddleware({ core }),
        });

        let caught: unknown;
        try {
            await generateText({ model, prompt: "hi", maxRetries: 0 });
        } catch (e) {
            caught = e;
        }
        expect(APICallError.isInstance(caught)).toBe(true);
    });
});

describe("real openai adapter through bursoraMiddleware — only the network is mocked — wrapStream", () => {
    test("passes parts through, records usage from the terminal chunk and requestId from the stream", async () => {
        const body = sse(
            {
                id: "c-1",
                object: "chat.completion.chunk",
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: "hello" },
                        finish_reason: null,
                    },
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
                usage: {
                    prompt_tokens: 9,
                    completion_tokens: 4,
                    total_tokens: 13,
                    prompt_tokens_details: { cached_tokens: 1 },
                },
            },
        );
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const model = wrapped(
            openaiChat(recordingFetch(calls, () => Promise.resolve(sseResponse(body)))),
            h.core,
        );

        const result = streamText({ model, prompt: "hi" });
        let collected = "";
        for await (const delta of result.textStream) collected += delta;

        expect(collected).toBe("hello");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(8);
        expect(h.events[0]?.completionTokens).toBe(4);
        expect(h.events[0]?.cacheTokens).toBe(1);
        expect(h.events[0]?.requestId).toBe("c-1");
    });
});

describe("real openai adapter through bursoraMiddleware — only the network is mocked — tag threading", () => {
    test("closure < withTags < providerOptions.bursora precedence", async () => {
        const h = buildFakeCore(ALLOW);
        const model = wrapped(
            openaiChat(recordingFetch([], () => Promise.resolve(jsonResponse(CHAT_BODY)))),
            h.core,
            { tenant_id: "closure", agent_id: "closure" },
        );

        await withTags({ tenant_id: "als", agent_id: "als" }, () =>
            generateText({
                model,
                prompt: "hi",
                providerOptions: { bursora: { tenant_id: "po" } },
            }),
        );

        // providerOptions wins for tenant_id; withTags wins where providerOptions is silent.
        expect(h.events[0]?.tenantId).toBe("po");
        expect(h.events[0]?.agentId).toBe("als");
    });
});

describe("real openai adapter through bursoraMiddleware — only the network is mocked — multi-step metering", () => {
    test("every tool-loop step records, so the recorded sum equals totalUsage", async () => {
        const toolCallBody = {
            id: "chatcmpl-step1",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: { name: "ping", arguments: "{}" },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
        const finalBody = {
            id: "chatcmpl-step2",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "done" },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
        };

        // Stateful network: first request is answered with a tool call, the
        // second (after the SDK runs the tool) with the final text.
        const calls: RecordedFetchCall[] = [];
        const fetchImpl = recordingFetch(calls, () =>
            Promise.resolve(jsonResponse(calls.length === 1 ? toolCallBody : finalBody)),
        );
        const h = buildFakeCore(ALLOW);
        const model = wrapped(openaiChat(fetchImpl), h.core);

        const out = await generateText({
            model,
            prompt: "hi",
            tools: {
                ping: tool({
                    description: "ping",
                    inputSchema: z.object({}),
                    execute: async () => "pong",
                }),
            },
            stopWhen: stepCountIs(5),
        });

        expect(out.text).toBe("done");
        expect(calls).toHaveLength(2);
        expect(h.events).toHaveLength(2);
        const prompt = h.events.reduce((s, e) => s + e.promptTokens, 0);
        const completion = h.events.reduce((s, e) => s + e.completionTokens, 0);
        expect(prompt).toBe(out.totalUsage.inputTokens ?? 0);
        expect(completion).toBe(out.totalUsage.outputTokens ?? 0);
    });
});

describe("real openai embedding adapter through bursoraEmbeddingMiddleware — only the network is mocked", () => {
    const embedModel = (fetchImpl: typeof fetch, core: ReturnType<typeof buildFakeCore>["core"]) =>
        wrapEmbeddingModel({
            model: createOpenAI({ apiKey: "test", fetch: fetchImpl }).embedding(
                "text-embedding-3-small",
            ),
            middleware: bursoraEmbeddingMiddleware({ core }),
        });

    const embedBody = (tokens: number) => ({
        object: "list",
        model: "text-embedding-3-small",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: tokens, total_tokens: tokens },
    });

    test("embed records input tokens as promptTokens, no completion, provider normalized", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const model = embedModel(
            recordingFetch(calls, () => Promise.resolve(jsonResponse(embedBody(50)))),
            h.core,
        );

        await embed({ model, value: "hello" });

        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("text-embedding-3-small");
        expect(h.events[0]?.promptTokens).toBe(50);
        expect(h.events[0]?.completionTokens).toBe(0);
        expect(h.events[0]?.errored).toBeFalsy();
    });

    test("embedMany meters each underlying embed call", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        // Each input over the model's batch limit triggers its own request; two
        // short strings fit one call, so usage records once.
        const model = embedModel(
            recordingFetch(calls, () => Promise.resolve(jsonResponse(embedBody(12)))),
            h.core,
        );

        await embedMany({ model, values: ["a", "b"] });

        expect(h.events.length).toBeGreaterThanOrEqual(1);
        expect(h.events.reduce((s, e) => s + e.promptTokens, 0)).toBeGreaterThan(0);
    });

    test("block decision throws before any network call; no event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(BLOCK);
        const model = embedModel(
            recordingFetch(calls, () => Promise.resolve(jsonResponse(embedBody(50)))),
            h.core,
        );

        await expect(embed({ model, value: "hello" })).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider 429 records an errored event and rethrows", async () => {
        const h = buildFakeCore(ALLOW);
        const model = embedModel(
            recordingFetch([], () =>
                Promise.resolve(
                    jsonResponse({ error: { message: "boom", type: "rate_limit_exceeded" } }, 429),
                ),
            ),
            h.core,
        );

        let caught: unknown;
        try {
            await embed({ model, value: "hello", maxRetries: 0 });
        } catch (e) {
            caught = e;
        }

        expect(APICallError.isInstance(caught)).toBe(true);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(0);
    });
});

describe("real openai image adapter through bursoraImageMiddleware — only the network is mocked", () => {
    const imageModel = (
        modelId: string,
        fetchImpl: typeof fetch,
        core: ReturnType<typeof buildFakeCore>["core"],
    ) =>
        wrapImageModel({
            model: createOpenAI({ apiKey: "test", fetch: fetchImpl }).image(modelId),
            middleware: bursoraImageMiddleware({ core }),
        });

    test("gpt-image-1 maps input/output tokens to prompt/completion", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const model = imageModel(
            "gpt-image-1",
            recordingFetch(calls, () =>
                Promise.resolve(
                    jsonResponse({
                        created: 1,
                        data: [{ b64_json: "aGk=" }],
                        usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 },
                    }),
                ),
            ),
            h.core,
        );

        await generateImage({ model, prompt: "a cat" });

        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-image-1");
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(30);
    });

    test("per-image model with no token usage still gates and records 0 tokens", async () => {
        const h = buildFakeCore(ALLOW);
        const model = imageModel(
            "dall-e-3",
            recordingFetch([], () =>
                Promise.resolve(jsonResponse({ created: 1, data: [{ b64_json: "aGk=" }] })),
            ),
            h.core,
        );

        await generateImage({ model, prompt: "a cat" });

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.model).toBe("dall-e-3");
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("block decision throws before any network call; no event", async () => {
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(BLOCK);
        const model = imageModel(
            "gpt-image-1",
            recordingFetch(calls, () =>
                Promise.resolve(jsonResponse({ created: 1, data: [{ b64_json: "aGk=" }] })),
            ),
            h.core,
        );

        await expect(generateImage({ model, prompt: "a cat" })).rejects.toBeInstanceOf(
            BudgetExceededError,
        );
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });
});

describe("real anthropic adapter through bursoraMiddleware — only the network is mocked", () => {
    test("maps a real anthropic messages call: cache read+write summed, prompt excludes cache", async () => {
        const model = "claude-3-5-sonnet-20241022";
        const body = jsonResponse({
            id: "msg_real_01",
            type: "message",
            role: "assistant",
            model,
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
        const calls: RecordedFetchCall[] = [];
        const h = buildFakeCore(ALLOW);
        const adapter = createAnthropic({
            apiKey: "test",
            fetch: recordingFetch(calls, () => Promise.resolve(body)),
        })(model);
        const wired = wrapLanguageModel({
            model: adapter,
            middleware: bursoraMiddleware({ core: h.core }),
        });

        const out = await generateText({ model: wired, prompt: "hi" });

        expect(out.text).toBe("hi");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("anthropic");
        expect(h.events[0]?.model).toBe(model);
        // The adapter folds cache_creation + cache_read into inputTokens.total;
        // both must land in cacheTokens (not promptTokens), matching the native
        // Anthropic wrap which records prompt=input_tokens, cache=creation+read.
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.cacheTokens).toBe(500);
        expect(h.events[0]?.completionTokens).toBe(9);
    });
});
