/**
 * Google Gemini native (`@google/genai`) manifest behaviors via `wrap(client, core)`:
 *  - intercepts client.models.generateContent
 *  - non-stream: maps usageMetadata.promptTokenCount / candidatesTokenCount to Usage
 *  - cache mapping: cachedContentTokenCount split out of promptTokenCount
 *  - thoughts: thoughtsTokenCount folded into completionTokens
 *  - block decision throws BudgetExceededError BEFORE the provider call
 *  - provider error path emits errored event and rethrows
 *  - streaming: intercepts models.generateContentStream; reads cumulative
 *    usageMetadata from the final chunk
 *
 * Tests use a mock @google/genai client (we don't depend on the package).
 * Structural typing only.
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";
import { createGoogleStreamHandler } from "../src/providers/google";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface MockGoogle {
    models: {
        generateContent: (args: unknown) => Promise<unknown>;
        generateContentStream: (args: unknown) => Promise<unknown>;
    };
}

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheTokens?: number;
    readonly errored?: boolean;
}

const buildHarness = (decision: Decision | null = ALLOW) => {
    const events: RecordedEvent[] = [];
    const decisionClient: DecisionLookup = {
        fetchDecision: async () => decision,
    };
    const eventsClient: EventsClient = {
        record: (e) => events.push(e as RecordedEvent),
        flush: async () => {},
    };
    const core: BursoraCore = {
        decision: decisionClient,
        events: eventsClient,
        now: () => 1_000,
        flush: async () => {},
        dispose: () => {},
    };
    return { events, decisionClient, eventsClient, core };
};

const noopStream: MockGoogle["models"]["generateContentStream"] = async () => {
    async function* empty() {}
    return empty();
};

describe("wrap(google)", () => {
    test("intercepts models.generateContent and emits one event with prompt/candidate tokens", async () => {
        const calls: { args: unknown }[] = [];
        const h = buildHarness();
        const client: MockGoogle = {
            models: {
                generateContent: async (args: unknown) => {
                    calls.push({ args });
                    return {
                        responseId: "resp_01",
                        usageMetadata: {
                            promptTokenCount: 13,
                            candidatesTokenCount: 9,
                            totalTokenCount: 22,
                        },
                    };
                },
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.models.generateContent({
            model: "gemini-2.5-flash",
            contents: "hi",
        })) as { responseId: string };
        expect(out.responseId).toBe("resp_01");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
        expect(h.events[0]?.model).toBe("gemini-2.5-flash");
        expect(h.events[0]?.promptTokens).toBe(13);
        expect(h.events[0]?.completionTokens).toBe(9);
    });

    test("splits cachedContentTokenCount out of promptTokenCount into cacheTokens", async () => {
        const h = buildHarness();
        const client: MockGoogle = {
            models: {
                generateContent: async () => ({
                    usageMetadata: {
                        promptTokenCount: 500,
                        candidatesTokenCount: 50,
                        cachedContentTokenCount: 200,
                        totalTokenCount: 550,
                    },
                }),
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        await wrapped.models.generateContent({ model: "gemini-2.5-pro", contents: "x" });
        expect(h.events).toHaveLength(1);
        // 500 prompt total - 200 cached = 300 uncached prompt
        expect(h.events[0]?.promptTokens).toBe(300);
        expect(h.events[0]?.completionTokens).toBe(50);
        expect(h.events[0]?.cacheTokens).toBe(200);
    });

    test("folds thoughtsTokenCount into completionTokens", async () => {
        const h = buildHarness();
        const client: MockGoogle = {
            models: {
                generateContent: async () => ({
                    usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 20,
                        thoughtsTokenCount: 15,
                        totalTokenCount: 45,
                    },
                }),
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        await wrapped.models.generateContent({ model: "gemini-2.5-pro", contents: "think" });
        expect(h.events[0]?.promptTokens).toBe(10);
        // 20 candidates + 15 thoughts = 35
        expect(h.events[0]?.completionTokens).toBe(35);
    });

    test("missing cache/thoughts fields default to no cache and bare candidates", async () => {
        const h = buildHarness();
        const client: MockGoogle = {
            models: {
                generateContent: async () => ({
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
                }),
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        await wrapped.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(7);
        const c = h.events[0]?.cacheTokens;
        expect(c === undefined || c === 0).toBe(true);
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        const calls: { args: unknown }[] = [];
        const h = buildHarness(BLOCK);
        const client: MockGoogle = {
            models: {
                generateContent: async (args: unknown) => {
                    calls.push({ args });
                    return { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
                },
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.models.generateContent({ model: "gemini-2.5-flash", contents: "x" }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("provider error path emits errored event and rethrows", async () => {
        const h = buildHarness();
        const client: MockGoogle = {
            models: {
                generateContent: async () => {
                    throw new Error("gemini 429");
                },
                generateContentStream: noopStream,
            },
        };
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.models.generateContent({ model: "gemini-2.5-flash", contents: "x" }),
        ).rejects.toThrow("gemini 429");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.provider).toBe("google");
    });

    test("streaming reads cumulative usageMetadata from the final chunk", async () => {
        const h = buildHarness();
        async function* geminiStream() {
            yield {
                responseId: "resp_str",
                candidates: [{ content: { parts: [{ text: "He" }] } }],
            };
            yield { candidates: [{ content: { parts: [{ text: "llo" }] } }] };
            yield {
                candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
                usageMetadata: {
                    promptTokenCount: 12,
                    candidatesTokenCount: 8,
                    thoughtsTokenCount: 4,
                    cachedContentTokenCount: 3,
                    totalTokenCount: 24,
                },
            };
        }
        const client: MockGoogle = {
            models: {
                generateContent: async () => ({ usageMetadata: {} }),
                generateContentStream: async () => geminiStream(),
            },
        };
        const wrapped = wrap(client, h.core);
        const stream = (await wrapped.models.generateContentStream({
            model: "gemini-2.5-flash",
            contents: "hi",
        })) as AsyncIterable<unknown>;
        let chunks = 0;
        for await (const _c of stream) {
            void _c;
            chunks += 1;
        }
        expect(chunks).toBe(3);
        expect(h.events).toHaveLength(1);
        // 12 prompt - 3 cached = 9 uncached
        expect(h.events[0]?.promptTokens).toBe(9);
        // 8 candidates + 4 thoughts = 12
        expect(h.events[0]?.completionTokens).toBe(12);
        expect(h.events[0]?.cacheTokens).toBe(3);
    });

    test("streaming sums correctly when intermediate chunks carry partial cumulative usage", async () => {
        const h = buildHarness();
        async function* stream() {
            yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
            yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
            yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 9 } };
        }
        const client: MockGoogle = {
            models: {
                generateContent: async () => ({ usageMetadata: {} }),
                generateContentStream: async () => stream(),
            },
        };
        const wrapped = wrap(client, h.core);
        const iter = (await wrapped.models.generateContentStream({
            model: "gemini-2.5-flash",
            contents: "hi",
        })) as AsyncIterable<unknown>;
        for await (const _c of iter) void _c;
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(10);
        // cumulative, not summed: final candidates total is 9, not 16
        expect(h.events[0]?.completionTokens).toBe(9);
    });

    test("detects native shape on models.generateContent even without generateContentStream", async () => {
        const h = buildHarness();
        const client = {
            models: {
                generateContent: async () => ({
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
                }),
            },
        };
        const wrapped = wrap(client as unknown as MockGoogle, h.core);
        await wrapped.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("google");
    });

    test("stream handler emits delta for the final cumulative chunk", () => {
        const handler = createGoogleStreamHandler();
        expect(handler({ candidates: [{ content: { parts: [{ text: "a" }] } }] })).toBeNull();
        const delta = handler({
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 10,
                cachedContentTokenCount: 5,
            },
        });
        expect(delta?.promptTokensDelta).toBe(15);
        expect(delta?.completionTokensDelta).toBe(10);
        expect(delta?.cacheTokensDelta).toBe(5);
    });
});
