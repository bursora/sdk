/**
 * DeepSeek metering via the baseURL → vendor map.
 *
 * DeepSeek has no first-party SDK; users wrap either the openai or
 * @anthropic-ai/sdk client with `baseURL` overridden to api.deepseek.com.
 * DeepSeek is one data row, not a manifest. `wrap()` must:
 *   - Tag emitted events `provider: "deepseek"` when baseURL matches
 *   - Fall back to the adapter's native openai/anthropic tag when it doesn't
 *   - Share the existing extractors (no duplicate token math)
 */

import { describe, expect, test } from "bun:test";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
}

const buildHarness = () => {
    const events: RecordedEvent[] = [];
    const core: BursoraCore = {
        decision: { fetchDecision: async () => ALLOW } satisfies DecisionLookup,
        events: {
            record: (e) => events.push(e as RecordedEvent),
            flush: async () => {},
        } satisfies EventsClient,
        now: () => 1_000,
        flush: async () => {},
        dispose: () => {},
    };
    return { events, core };
};

const openaiShape = (baseURL?: string) => ({
    ...(baseURL === undefined ? {} : { baseURL }),
    chat: {
        completions: {
            create: async (_args: unknown) => ({
                id: "c-ds-1",
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    prompt_tokens_details: { cached_tokens: 40 },
                },
            }),
        },
    },
    embeddings: {
        create: async (_args: unknown) => ({
            usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
    },
});

const anthropicShape = (baseURL?: string) => ({
    ...(baseURL === undefined ? {} : { baseURL }),
    messages: {
        create: async (_args: unknown) => ({
            id: "m-ds-1",
            usage: { input_tokens: 7, output_tokens: 11 },
        }),
    },
});

describe("wrap() — DeepSeek detection", () => {
    test("openai-shape + baseURL contains 'deepseek' → provider 'deepseek'", async () => {
        const h = buildHarness();
        const client = openaiShape("https://api.deepseek.com");
        const wrapped = wrap(client, h.core);
        await wrapped.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("deepseek");
        expect(h.events[0]?.model).toBe("deepseek-chat");
    });

    test("openai-shape with no baseURL falls through → provider 'openai'", async () => {
        const h = buildHarness();
        const client = openaiShape();
        const wrapped = wrap(client, h.core);
        await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.provider).toBe("openai");
    });

    test("openai-shape + non-deepseek baseURL → provider 'openai'", async () => {
        const h = buildHarness();
        const client = openaiShape("https://api.openai.com/v1");
        const wrapped = wrap(client, h.core);
        await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.provider).toBe("openai");
    });

    test("anthropic-shape + baseURL '.../deepseek.com/anthropic' → provider 'deepseek'", async () => {
        const h = buildHarness();
        const client = anthropicShape("https://api.deepseek.com/anthropic");
        const wrapped = wrap(client, h.core);
        await wrapped.messages.create({
            model: "deepseek-v4-flash",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.provider).toBe("deepseek");
        expect(h.events[0]?.model).toBe("deepseek-v4-flash");
    });

    test("anthropic-shape with default baseURL → provider 'anthropic'", async () => {
        const h = buildHarness();
        const client = anthropicShape("https://api.anthropic.com");
        const wrapped = wrap(client, h.core);
        await wrapped.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.provider).toBe("anthropic");
    });

    test("deepseek tag inherits openai cache-token math", async () => {
        const h = buildHarness();
        const client = openaiShape("https://api.deepseek.com");
        const wrapped = wrap(client, h.core);
        await wrapped.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.promptTokens).toBe(60); // 100 - 40 cached
        expect(h.events[0]?.completionTokens).toBe(20);
        expect(h.events[0]?.cacheTokens).toBe(40);
    });

    test("baseURL with non-string type does not trigger deepseek detection", async () => {
        const h = buildHarness();
        const client = {
            baseURL: { toString: () => "https://api.deepseek.com" },
            ...openaiShape(),
        };
        const wrapped = wrap(client, h.core);
        await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(h.events[0]?.provider).toBe("openai");
    });
});
