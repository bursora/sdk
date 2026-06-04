/**
 * Drives the real `@google/genai` client through `wrap()`. Only the network is
 * mocked, but Google's SDK has no custom-`fetch` constructor hook — it calls
 * `globalThis.fetch` directly — so this suite stubs `globalThis.fetch` per test
 * and RESTORES it in `afterEach` (necessary seam; runs even when a test throws,
 * so the global stub can't leak into other suites in the shared `bun test`
 * process). With only the network faked, the SDK's own request build, response
 * parsing, error classes, and stream decoding all run for real. The streaming
 * fixture is hand-rolled inline: Google's wire SSE carries no `[DONE]` sentinel.
 *
 * Coverage:
 *  - non-stream `generateContent` → cache split out of prompt, thoughts folded
 *    into completion.
 *  - `generateContentStream` (`:streamGenerateContent?alt=sse`) → usage read
 *    from the terminal chunk.
 *  - block decision throws before the provider call; no event, no fetch.
 *  - provider 4xx JSON → real `ApiError` with `.status`; errored event +
 *    rethrow.
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../../src/errors";
import type { Decision } from "../../src/types";
import { wrap } from "../../src/wrap";
import { buildFakeCore, jsonResponse, sseResponse } from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

const MODEL = "gemini-2.5-flash";
const EMBED_MODEL = "gemini-embedding-001";
const IMAGE_MODEL = "imagen-4.0-generate-001";

const NON_STREAM_BODY = {
    candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        totalTokenCount: 19,
        cachedContentTokenCount: 4,
        thoughtsTokenCount: 2,
    },
};

// Tool-execution input tokens (`toolUsePromptTokenCount`) are a separate addend
// in `totalTokenCount`, billed at the input rate. They fold into the prompt.
const TOOL_USE_BODY = {
    candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: {
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
        cachedContentTokenCount: 4,
        totalTokenCount: 24,
    },
};

// `:embedContent` and `:predict` (Imagen) responses carry no usageMetadata.
// The Developer API omits per-embedding `statistics`; Vertex includes it.
const EMBED_BODY = { embeddings: [{ values: [0.1, 0.2, 0.3] }] };
const EMBED_BODY_WITH_STATS = {
    embeddings: [
        { values: [0.1], statistics: { tokenCount: 7 } },
        { values: [0.2], statistics: { tokenCount: 5 } },
    ],
};
const IMAGE_BODY = { predictions: [{ bytesBase64Encoded: "aGk=", mimeType: "image/png" }] };

// Google's wire SSE carries no `[DONE]` sentinel, so the data-frames are
// hand-rolled here rather than built with the shared OpenAI-style `sse()`.
const STREAM_BODY =
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "He" }] } }] })}\n\n` +
    `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "llo" }] }, finishReason: "STOP" }],
        usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 8,
            totalTokenCount: 27,
            cachedContentTokenCount: 3,
            thoughtsTokenCount: 4,
        },
    })}\n\n`;

describe("real @google/genai through wrap() — only the network is mocked", () => {
    const originalFetch = globalThis.fetch;
    let calls: string[] = [];

    const stubFetch = (impl: (url: string) => Response): void => {
        calls = [];
        globalThis.fetch = ((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push(url);
            return Promise.resolve(impl(url));
        }) as typeof fetch;
    };

    beforeEach(() => {
        calls = [];
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("non-stream generateContent records one event, cache split and thoughts folded", async () => {
        stubFetch(() => jsonResponse(NON_STREAM_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const out = await wrapped.models.generateContent({ model: MODEL, contents: "hi" });

        expect(out.text).toBe("hi");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain(`${MODEL}:generateContent`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe(MODEL);
        // 10 prompt - 4 cached = 6 uncached
        expect(h.events[0]?.promptTokens).toBe(6);
        // 3 candidates + 2 thoughts = 5
        expect(h.events[0]?.completionTokens).toBe(5);
        expect(h.events[0]?.cacheTokens).toBe(4);
    });

    test("generateContent folds tool-use input tokens into the prompt count", async () => {
        stubFetch(() => jsonResponse(TOOL_USE_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        await wrapped.models.generateContent({ model: MODEL, contents: "hi" });

        expect(h.events).toHaveLength(1);
        // (10 prompt + 5 tool-use) - 4 cached = 11 uncached
        expect(h.events[0]?.promptTokens).toBe(11);
        // 3 candidates + 2 thoughts = 5
        expect(h.events[0]?.completionTokens).toBe(5);
        expect(h.events[0]?.cacheTokens).toBe(4);
    });

    test("embedContent records one event with zero tokens (no usage reported)", async () => {
        stubFetch(() => jsonResponse(EMBED_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const out = await wrapped.models.embedContent({ model: EMBED_MODEL, contents: "hi" });

        expect(out.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3]);
        expect(calls).toHaveLength(1);
        // The SDK routes a single embedContent call to the batch wire endpoint.
        expect(calls[0]).toContain(`${EMBED_MODEL}:batchEmbedContents`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe(EMBED_MODEL);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
        expect(h.events[0]?.cacheTokens).toBeUndefined();
    });

    test("embedContent sums per-embedding input tokens from statistics (Vertex)", async () => {
        // `statistics.tokenCount` is Vertex-only; the extractor sums it across
        // the batch wherever the response carries it. Embeddings have no
        // completion, so completionTokens stays 0.
        stubFetch(() => jsonResponse(EMBED_BODY_WITH_STATS));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        await wrapped.models.embedContent({ model: EMBED_MODEL, contents: ["a", "b"] });

        expect(h.events).toHaveLength(1);
        // 7 + 5 = 12 input tokens
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("vertex-backed client stamps provider=vertex and the client region", async () => {
        stubFetch(() => jsonResponse(NON_STREAM_BODY));
        const h = buildFakeCore(ALLOW);
        // A Vertex client (project/location, no apiKey) speaks the same shape;
        // `vertexai` + `location` drive the labels.
        const wrapped = wrap(
            new GoogleGenAI({ vertexai: true, project: "p", location: "us-central1" }),
            h.core,
        );

        // Vertex auth needs ADC credentials the test env lacks, so the call may
        // reject before the (stubbed) network. Either way the lifecycle records
        // exactly one event carrying the resolved vertex labels.
        try {
            await wrapped.models.generateContent({ model: MODEL, contents: "hi" });
        } catch {
            // asserting the recorded labels, not the call outcome
        }

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("vertex");
        expect(h.events[0]?.region).toBe("us-central1");
        expect(h.events[0]?.model).toBe(MODEL);
    });

    test("generateImages records one event with zero tokens (Imagen bills per image)", async () => {
        stubFetch(() => jsonResponse(IMAGE_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const out = await wrapped.models.generateImages({ model: IMAGE_MODEL, prompt: "a cat" });

        expect(out.generatedImages).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain(`${IMAGE_MODEL}:predict`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe(IMAGE_MODEL);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("chats.create().sendMessage records one event with the model bound at create", async () => {
        stubFetch(() => jsonResponse(NON_STREAM_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const chat = wrapped.chats.create({ model: MODEL });
        const out = await chat.sendMessage({ message: "hi" });

        expect(out.text).toBe("hi");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain(`${MODEL}:generateContent`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe(MODEL);
        expect(h.events[0]?.promptTokens).toBe(6);
        expect(h.events[0]?.completionTokens).toBe(5);
        expect(h.events[0]?.cacheTokens).toBe(4);
    });

    test("block decision on chats.create().sendMessage throws before the provider call", async () => {
        stubFetch(() => jsonResponse(NON_STREAM_BODY));
        const h = buildFakeCore(BLOCK);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const chat = wrapped.chats.create({ model: MODEL });
        await expect(chat.sendMessage({ message: "hi" })).rejects.toBeInstanceOf(
            BudgetExceededError,
        );
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("chats.create().sendMessageStream records one event from the terminal chunk", async () => {
        stubFetch(() => sseResponse(STREAM_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const chat = wrapped.chats.create({ model: MODEL });
        const stream = await chat.sendMessageStream({ message: "hi" });
        const collected: string[] = [];
        for await (const chunk of stream) {
            const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) collected.push(text);
        }

        expect(collected).toEqual(["He", "llo"]);
        expect(calls[0]).toContain(`${MODEL}:streamGenerateContent?alt=sse`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.model).toBe(MODEL);
        expect(h.events[0]?.promptTokens).toBe(9);
        expect(h.events[0]?.completionTokens).toBe(12);
        expect(h.events[0]?.cacheTokens).toBe(3);
    });

    test("editImage is instrumented: rejects on a Developer API client and records an errored event", async () => {
        stubFetch(() => jsonResponse(IMAGE_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        // editImage is Vertex-AI / GEAP only; the SDK rejects it on a
        // Developer-API client. The proxy still installed the leaf and ran the
        // lifecycle, so the failed attempt is recorded.
        await expect(
            wrapped.models.editImage({ model: IMAGE_MODEL, prompt: "x", referenceImages: [] }),
        ).rejects.toThrow();
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe(IMAGE_MODEL);
        expect(h.events[0]?.errored).toBe(true);
    });

    test("streaming records one event with usage from the terminal chunk", async () => {
        stubFetch(() => sseResponse(STREAM_BODY));
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        const stream = await wrapped.models.generateContentStream({ model: MODEL, contents: "hi" });
        const collected: string[] = [];
        for await (const chunk of stream) {
            const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) collected.push(text);
        }

        expect(collected).toEqual(["He", "llo"]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain(`${MODEL}:streamGenerateContent?alt=sse`);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        // 12 prompt - 3 cached = 9 uncached
        expect(h.events[0]?.promptTokens).toBe(9);
        // 8 candidates + 4 thoughts = 12
        expect(h.events[0]?.completionTokens).toBe(12);
        expect(h.events[0]?.cacheTokens).toBe(3);
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        stubFetch(() => jsonResponse(NON_STREAM_BODY));
        const h = buildFakeCore(BLOCK);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        await expect(
            wrapped.models.generateContent({ model: MODEL, contents: "hi" }),
        ).rejects.toThrow();
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider error emits an errored event and rethrows ApiError with status", async () => {
        stubFetch(() =>
            jsonResponse(
                { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } },
                429,
            ),
        );
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(new GoogleGenAI({ apiKey: "test" }), h.core);

        let caught: unknown;
        try {
            await wrapped.models.generateContent({ model: MODEL, contents: "hi" });
        } catch (err: unknown) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status).toBe(429);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.errored).toBe(true);
    });
});
