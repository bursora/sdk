/**
 * wrap() provider auto-detection.
 *
 * The 2-arg `wrap(client, core)` form sniffs the client structurally and
 * picks a built-in manifest. These tests pin the detection contract: which
 * shapes match which provider, what happens on no match, and the
 * deterministic tie-breaker when a client looks like both.
 */

import { describe, expect, test } from "bun:test";
import type { SetupErrorInput } from "../src/internal/events";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };

const buildCore = (setupErrors?: SetupErrorInput[]): BursoraCore => {
    const decision: DecisionLookup = { fetchDecision: async () => ALLOW };
    const events: EventsClient = {
        record: () => {},
        flush: async () => {},
        recordSetupError: (e) => {
            setupErrors?.push(e);
        },
    };
    return {
        decision,
        events,
        now: () => 1_000,
        flush: async () => {},
        dispose: () => {},
    };
};

const openaiShape = () => ({
    chat: {
        completions: {
            create: async (_args: unknown) => ({
                id: "c1",
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        },
    },
    embeddings: {
        create: async (_args: unknown) => ({ usage: { prompt_tokens: 1, total_tokens: 1 } }),
    },
});

const anthropicShape = () => ({
    messages: {
        create: async (_args: unknown) => ({
            id: "m1",
            usage: { input_tokens: 1, output_tokens: 1 },
        }),
    },
});

const googleShape = () => ({
    models: {
        generateContent: async (_args: unknown) => ({
            responseId: "g1",
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
    },
});

describe("wrap() — provider detection", () => {
    test("detects an OpenAI-shaped client", async () => {
        const core = buildCore();
        const client = openaiShape();
        const wrapped = wrap(client, core);
        const out = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        })) as { id: string };
        expect(out.id).toBe("c1");
    });

    test("detects an Anthropic-shaped client", async () => {
        const core = buildCore();
        const client = anthropicShape();
        const wrapped = wrap(client, core);
        const out = (await wrapped.messages.create({
            model: "claude-3-5-sonnet-latest",
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
        })) as { id: string };
        expect(out.id).toBe("m1");
    });

    test("detects a Google-shaped client", async () => {
        const core = buildCore();
        const client = googleShape();
        const wrapped = wrap(client, core);
        const out = (await wrapped.models.generateContent({
            model: "gemini-2.5-flash",
            contents: "hi",
        })) as { responseId: string };
        expect(out.responseId).toBe("g1");
    });

    test("throws a clear error on a plain {} client", () => {
        const core = buildCore();
        expect(() => wrap({} as object, core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("fires a setup-error event before throwing on unknown client shape", () => {
        const setupErrors: SetupErrorInput[] = [];
        const core = buildCore(setupErrors);
        expect(() => wrap({} as object, core)).toThrow();
        expect(setupErrors).toHaveLength(1);
        expect(setupErrors[0]?.kind).toBe("sdk_unknown_provider");
    });

    test("setup-error path tolerates an EventsClient missing recordSetupError", () => {
        // Older or custom EventsClient impls may not implement the optional
        // `recordSetupError` method. The detection-failure path must still
        // throw the expected provider-detection error, never a TypeError
        // about a missing or non-callable method.
        const events: EventsClient = {
            record: () => {},
            flush: async () => {},
        };
        const core: BursoraCore = {
            decision: { fetchDecision: async () => ALLOW },
            events,
            now: () => 1_000,
            flush: async () => {},
            dispose: () => {},
        };
        expect(() => wrap({} as object, core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("setup-error path tolerates an EventsClient with a non-function recordSetupError", () => {
        // Defensive: structural typing lets callers slip a non-callable value
        // past the type check. The detection-failure path must still throw
        // the expected provider-detection error, not a TypeError.
        const events = {
            record: () => {},
            flush: async () => {},
            recordSetupError: 42 as unknown,
        } as unknown as EventsClient;
        const core: BursoraCore = {
            decision: { fetchDecision: async () => ALLOW },
            events,
            now: () => 1_000,
            flush: async () => {},
            dispose: () => {},
        };
        expect(() => wrap({} as object, core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("prefers OpenAI when a client matches both shapes", async () => {
        const core = buildCore();
        // Hybrid client: has both OpenAI and Anthropic surface area.
        const hybrid = {
            ...openaiShape(),
            ...anthropicShape(),
        };
        const wrapped = wrap(hybrid, core);
        // If OpenAI won detection, chat.completions.create is instrumented and
        // returns the OpenAI-shaped response.
        const out = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        })) as { id: string };
        expect(out.id).toBe("c1");
    });

    test("provider slug is resolved from baseURL, independent of matched shape", async () => {
        // A hybrid client matches the OpenAI shape first, but its DeepSeek
        // baseURL — not the manifest — decides the emitted provider slug.
        const events: { provider: string }[] = [];
        const core: BursoraCore = {
            decision: { fetchDecision: async () => ALLOW },
            events: {
                record: (e) => events.push(e as { provider: string }),
                flush: async () => {},
            },
            now: () => 1_000,
            flush: async () => {},
            dispose: () => {},
        };
        const hybrid = {
            baseURL: "https://api.deepseek.com",
            ...openaiShape(),
            ...anthropicShape(),
        };
        const wrapped = wrap(hybrid, core);
        await wrapped.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(events[0]?.provider).toBe("deepseek");
    });

    test("an OpenAI client pointed at a Groq baseURL emits provider 'groq'", async () => {
        const events: { provider: string }[] = [];
        const core: BursoraCore = {
            decision: { fetchDecision: async () => ALLOW },
            events: {
                record: (e) => events.push(e as { provider: string }),
                flush: async () => {},
            },
            now: () => 1_000,
            flush: async () => {},
            dispose: () => {},
        };
        const client = { baseURL: "https://api.groq.com/openai/v1", ...openaiShape() };
        const wrapped = wrap(client, core);
        await wrapped.chat.completions.create({
            model: "llama-3.3-70b",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(events[0]?.provider).toBe("groq");
    });
});
