/**
 * OpenAI manifest behaviors via `wrap(client, core)`:
 *  - intercepts client.chat.completions.create
 *  - intercepts client.responses.create
 *  - non-stream: emits one usage event with extracted prompt/completion tokens
 *  - block decision throws BudgetExceededError BEFORE the provider call
 *  - streaming: passes the iterator through; emits event with summed usage
 *
 * Tests use a mock OpenAI client (we don't depend on the openai package).
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface MockClient {
    chat: {
        completions: {
            create: (args: unknown) => Promise<unknown>;
        };
    };
    responses: {
        create: (args: unknown) => Promise<unknown>;
    };
    embeddings: {
        create: (args: unknown) => Promise<unknown>;
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

const makeClient = (calls: { method: string; args: unknown }[]): MockClient => ({
    chat: {
        completions: {
            create: async (args: unknown) => {
                calls.push({ method: "chat.completions.create", args });
                return {
                    id: "chat-1",
                    model: "gpt-4o",
                    choices: [{ message: { role: "assistant", content: "ok" } }],
                    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
                };
            },
        },
    },
    responses: {
        create: async (args: unknown) => {
            calls.push({ method: "responses.create", args });
            return {
                id: "resp-1",
                model: "gpt-4o",
                usage: { input_tokens: 12, output_tokens: 8 },
            };
        },
    },
    embeddings: {
        create: async (args: unknown) => {
            calls.push({ method: "embeddings.create", args });
            return {
                object: "list",
                model: "text-embedding-3-small",
                data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
                usage: { prompt_tokens: 5, total_tokens: 5 },
            };
        },
    },
});

describe("wrap(openai)", () => {
    test("intercepts chat.completions.create and emits one event", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
        })) as { id: string };
        expect(out.id).toBe("chat-1");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("chat.completions.create");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("gpt-4o");
        expect(h.events[0]?.promptTokens).toBe(11);
        expect(h.events[0]?.completionTokens).toBe(7);
    });

    test("intercepts responses.create and emits one event", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.responses.create({
            model: "gpt-4o",
            input: "hi",
        })) as { id: string };
        expect(out.id).toBe("resp-1");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("responses.create");
        expect(h.events[0]?.promptTokens).toBe(12);
        expect(h.events[0]?.completionTokens).toBe(8);
    });

    test("block decision throws BudgetExceededError before the provider call", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness(BLOCK);
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("streaming chat completion passes through and emits on stream end", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();

        async function* streamChunks() {
            yield {
                id: "c-1",
                choices: [{ delta: { content: "hi" } }],
            };
            yield {
                id: "c-2",
                choices: [{ delta: { content: "!" } }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
            };
        }
        const streamingClient: MockClient = {
            chat: {
                completions: {
                    create: async (args: unknown) => {
                        calls.push({ method: "chat.completions.create", args });
                        return streamChunks();
                    },
                },
            },
            responses: {
                create: async () => {
                    throw new Error("not used");
                },
            },
            embeddings: {
                create: async () => {
                    throw new Error("not used");
                },
            },
        };

        const wrapped = wrap(streamingClient, h.core);
        const stream = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        })) as AsyncIterable<{ choices: Array<{ delta: { content: string } }> }>;
        const collected: string[] = [];
        for await (const chunk of stream) {
            collected.push(chunk.choices[0]?.delta.content ?? "");
        }
        expect(collected).toEqual(["hi", "!"]);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(4);
        expect(h.events[0]?.completionTokens).toBe(2);
    });

    test("streaming preserves cacheTokens when an early chunk reports cached_tokens and the final chunk omits usage", async () => {
        const h = buildHarness();

        // Per issue #979: track cache across chunks; don't lose it when the
        // final chunk omits usage.
        async function* streamChunks() {
            yield {
                id: "c-1",
                choices: [{ delta: { role: "assistant" } }],
                usage: {
                    prompt_tokens: 500,
                    completion_tokens: 0,
                    prompt_tokens_details: { cached_tokens: 100 },
                },
            };
            yield {
                id: "c-2",
                choices: [{ delta: { content: "hi" } }],
            };
        }
        const streamingClient: MockClient = {
            chat: {
                completions: {
                    create: async () => streamChunks(),
                },
            },
            responses: { create: async () => ({}) },
            embeddings: { create: async () => ({}) },
        };

        const wrapped = wrap(streamingClient, h.core);
        const stream = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        })) as AsyncIterable<unknown>;
        for await (const _ of stream) {
            // drain
        }
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheTokens).toBe(100);
        expect(h.events[0]?.promptTokens).toBe(400);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("streaming preserves cacheTokens when chunk reports only cached_tokens (no prompt_tokens) and final chunk omits usage", async () => {
        const h = buildHarness();

        // Edge case: a chunk reports cached_tokens without an accompanying
        // prompt_tokens. Subtracting cached from a zero prompt would underflow
        // the bill; the handler must track cache separately and never go
        // negative on promptTokens.
        async function* streamChunks() {
            yield {
                id: "c-1",
                choices: [{ delta: { role: "assistant" } }],
                usage: {
                    prompt_tokens_details: { cached_tokens: 100 },
                },
            };
            yield {
                id: "c-2",
                choices: [{ delta: { content: "ok" } }],
            };
        }
        const streamingClient: MockClient = {
            chat: {
                completions: {
                    create: async () => streamChunks(),
                },
            },
            responses: { create: async () => ({}) },
            embeddings: { create: async () => ({}) },
        };

        const wrapped = wrap(streamingClient, h.core);
        const stream = (await wrapped.chat.completions.create({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        })) as AsyncIterable<unknown>;
        for await (const _ of stream) {
            // drain
        }
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.cacheTokens).toBe(100);
        expect(h.events[0]?.promptTokens).toBe(0);
    });

    test("intercepts embeddings.create and emits one event with completionTokens: 0", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.embeddings.create({
            model: "text-embedding-3-small",
            input: "hello world",
        })) as { object: string };
        expect(out.object).toBe("list");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("embeddings.create");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.provider).toBe("openai");
        expect(h.events[0]?.model).toBe("text-embedding-3-small");
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("embeddings block decision throws BudgetExceededError before the provider call", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness(BLOCK);
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        await expect(
            wrapped.embeddings.create({
                model: "text-embedding-3-small",
                input: "hello world",
            }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(calls).toHaveLength(0);
        expect(h.events).toHaveLength(0);
    });

    test("embeddings ignores stream:true and treats response as a single object", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const client = makeClient(calls);
        const wrapped = wrap(client, h.core);
        const out = (await wrapped.embeddings.create({
            model: "text-embedding-3-small",
            input: "hello world",
            stream: true,
        })) as { object: string };
        expect(out.object).toBe("list");
        expect(calls).toHaveLength(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(5);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("intercepts beta.chat.completions.parse and emits one event", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const betaClient = {
            ...makeClient(calls),
            beta: {
                chat: {
                    completions: {
                        parse: async (args: unknown) => {
                            calls.push({ method: "beta.chat.completions.parse", args });
                            return {
                                id: "chat-parsed",
                                model: "gpt-4o",
                                choices: [
                                    {
                                        message: {
                                            role: "assistant",
                                            content: '{"x":1}',
                                            parsed: { x: 1 },
                                        },
                                    },
                                ],
                                usage: {
                                    prompt_tokens: 21,
                                    completion_tokens: 5,
                                    total_tokens: 26,
                                },
                            };
                        },
                    },
                },
            },
        };
        const wrapped = wrap(betaClient, h.core);
        const out = (await wrapped.beta.chat.completions.parse({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            response_format: { type: "json_schema" },
        })) as { choices: Array<{ message: { parsed: { x: number } } }> };
        expect(out.choices[0]?.message.parsed.x).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("beta.chat.completions.parse");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(21);
        expect(h.events[0]?.completionTokens).toBe(5);
    });

    test("passes through untouched surface (e.g. models) without interception", async () => {
        const calls: { method: string; args: unknown }[] = [];
        const h = buildHarness();
        const clientWithModels = {
            ...makeClient(calls),
            models: {
                list: async () => {
                    calls.push({ method: "models.list", args: undefined });
                    return { data: [{ id: "gpt-4o" }] };
                },
            },
        };
        const wrapped = wrap(clientWithModels, h.core);
        const out = (await wrapped.models.list()) as { data: Array<{ id: string }> };
        expect(out.data[0]?.id).toBe("gpt-4o");
        expect(h.events).toHaveLength(0);
    });

    test("throws at setup when client lacks chat.completions.create", () => {
        const h = buildHarness();
        const bogus = { embeddings: { create: async () => ({}) } } as unknown as MockClient;
        expect(() => wrap(bogus, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("throws at setup when client lacks embeddings.create", () => {
        const h = buildHarness();
        const bogus = {
            chat: { completions: { create: async () => ({}) } },
        } as unknown as MockClient;
        expect(() => wrap(bogus, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("throws at setup when a plain object is passed", () => {
        const h = buildHarness();
        expect(() => wrap({} as unknown as MockClient, h.core)).toThrow(
            /\[bursora\] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google \(Gemini\)-shaped client/,
        );
    });

    test("provider error path emits errored event and rethrows", async () => {
        const h = buildHarness();
        const failingClient: MockClient = {
            chat: {
                completions: {
                    create: async () => {
                        throw new Error("rate limited");
                    },
                },
            },
            responses: { create: async () => ({}) },
            embeddings: { create: async () => ({}) },
        };
        const wrapped = wrap(failingClient, h.core);
        await expect(
            wrapped.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toThrow("rate limited");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
    });
});
