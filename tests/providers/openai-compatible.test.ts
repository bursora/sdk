/**
 * Drives OpenAI-compatible vendors through `wrap()` using the real `openai`
 * client pointed at each vendor's base URL. Only the network is mocked: each
 * client gets an injected `fetch` (the shared harness's `recordingFetch`) and
 * `maxRetries: 0`, so the SDK's own request build, response parsing, error
 * classes, and stream decoding run for real. These vendors ship no first-party
 * SDK; one real wrapped client per vendor proves end to end that `wrap()` tags
 * the event with the slug resolved from `client.baseURL` (the HOST_VENDORS map)
 * while reusing the OpenAI usage extractor — cache subtraction inherited, no
 * duplicate token math. The default base URL falls through to `openai`.
 */

import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { BudgetExceededError } from "../../src/errors";
import type { Decision } from "../../src/types";
import { wrap } from "../../src/wrap";
import { buildFakeCore, jsonResponse, recordingFetch, type RecordedFetchCall } from "../_harness";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "over budget", ttl_s: 60 };

const COMPLETION_BODY = {
    id: "chatcmpl-compat",
    object: "chat.completion",
    model: "vendor-model",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
    },
};

const okFetch = (calls: RecordedFetchCall[]): typeof fetch =>
    recordingFetch(calls, () => Promise.resolve(jsonResponse(COMPLETION_BODY)));

// [baseURL, expected slug] — every OpenAI-compatible vendor in HOST_VENDORS.
const VENDORS: ReadonlyArray<readonly [string, string]> = [
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.groq.com/openai/v1", "groq"],
    ["https://api.x.ai/v1", "xai"],
    ["https://api.mistral.ai/v1", "mistral"],
    ["https://api.together.xyz/v1", "together"],
    ["https://api.fireworks.ai/inference/v1", "fireworks"],
    ["https://api.perplexity.ai", "perplexity"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://ai-gateway.vercel.sh/v1", "vercel"],
    ["http://localhost:11434/v1", "ollama"],
];

describe("real openai-compatible vendors through wrap() — only the network is mocked", () => {
    for (const [baseURL, slug] of VENDORS) {
        test(`${slug} baseURL records provider '${slug}' with inherited OpenAI token math`, async () => {
            const calls: RecordedFetchCall[] = [];
            const client = new OpenAI({
                apiKey: "test",
                baseURL,
                fetch: okFetch(calls),
                maxRetries: 0,
            });
            const h = buildFakeCore(ALLOW);
            const wrapped = wrap(client, h.core);

            await wrapped.chat.completions.create({
                model: "vendor-model",
                messages: [{ role: "user", content: "hi" }],
            });

            expect(calls).toHaveLength(1);
            expect(h.events).toHaveLength(1);
            expect(h.events[0]?.provider).toBe(slug);
            expect(h.events[0]?.promptTokens).toBe(60); // 100 - 40 cached
            expect(h.events[0]?.completionTokens).toBe(20);
            expect(h.events[0]?.cacheTokens).toBe(40);
        });
    }

    test("default openai baseURL falls through to provider 'openai'", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new OpenAI({ apiKey: "test", fetch: okFetch(calls), maxRetries: 0 });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });

        expect(client.baseURL).toContain("api.openai.com");
        expect(h.events[0]?.provider).toBe("openai");
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new OpenAI({
            apiKey: "test",
            baseURL: "https://api.deepseek.com",
            fetch: okFetch(calls),
            maxRetries: 0,
        });
        const h = buildFakeCore(BLOCK);
        const wrapped = wrap(client, h.core);

        await expect(
            wrapped.chat.completions.create({
                model: "vendor-model",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider error emits an errored event and rethrows", async () => {
        const calls: RecordedFetchCall[] = [];
        const client = new OpenAI({
            apiKey: "test",
            baseURL: "https://api.groq.com/openai/v1",
            fetch: recordingFetch(calls, () =>
                Promise.resolve(jsonResponse({ error: { message: "boom" } }, 500)),
            ),
            maxRetries: 0,
        });
        const h = buildFakeCore(ALLOW);
        const wrapped = wrap(client, h.core);

        await expect(
            wrapped.chat.completions.create({
                model: "vendor-model",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toThrow();
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("groq");
        expect(h.events[0]?.errored).toBe(true);
    });
});
