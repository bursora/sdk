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
import type { Decision } from "../../src/types";
import { wrap } from "../../src/wrap";
import { buildFakeCore, jsonResponse, sseResponse } from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

const MODEL = "gemini-2.5-flash";

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
