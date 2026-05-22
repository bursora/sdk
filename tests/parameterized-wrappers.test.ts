/**
 * Parameterized wrapper tests — same TDD scenarios run across all manifests.
 *
 * Verifies that the shared `wrap()` engine produces consistent behavior
 * regardless of which provider manifest it consumes: each pairing must pass
 * the decision + event lifecycle, fail open on null decisions, throw before
 * the provider call on block, and emit events with the right provider tag.
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";
import type { Decision } from "../src/types";
import { wrap, type BursoraCore, type DecisionLookup, type EventsClient } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
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

/**
 * Each scenario provides a way to build a mock provider client (for both
 * normal-response and error cases) and a way to invoke the wrapped surface.
 * The wrappers themselves see structurally identical surfaces — the harness
 * abstracts away the per-provider method shape.
 */
interface Scenario {
    readonly label: string;
    readonly provider: "openai" | "anthropic";
    readonly model: string;
    invoke(opts: {
        readonly core: BursoraCore;
        readonly clientResponse: "ok" | "error";
    }): Promise<unknown>;
}

const scenarios: readonly Scenario[] = [
    {
        label: "wrap(openai)",
        provider: "openai",
        model: "gpt-4o",
        invoke: async ({ core, clientResponse }) => {
            const client = {
                chat: {
                    completions: {
                        create: async (_args: unknown) => {
                            if (clientResponse === "error") throw new Error("boom");
                            return {
                                id: "openai-1",
                                model: "gpt-4o",
                                usage: { prompt_tokens: 1, completion_tokens: 2 },
                            };
                        },
                    },
                },
                responses: { create: async (_args: unknown) => ({}) },
                embeddings: { create: async (_args: unknown) => ({}) },
            };
            const wrapped = wrap(client, core);
            return wrapped.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            });
        },
    },
    {
        label: "wrap(anthropic)",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        invoke: async ({ core, clientResponse }) => {
            const client = {
                messages: {
                    create: async (_args: unknown) => {
                        if (clientResponse === "error") throw new Error("boom");
                        return {
                            id: "anthropic-1",
                            model: "claude-3-5-sonnet-20241022",
                            usage: { input_tokens: 1, output_tokens: 2 },
                        };
                    },
                },
            };
            const wrapped = wrap(client, core);
            return wrapped.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 16,
                messages: [{ role: "user", content: "hi" }],
            });
        },
    },
];

describe("parameterized wrappers — happy path", () => {
    for (const s of scenarios) {
        test(`${s.label} emits an event with provider='${s.provider}'`, async () => {
            const h = buildHarness();
            await s.invoke({ core: h.core, clientResponse: "ok" });
            expect(h.events).toHaveLength(1);
            expect(h.events[0]?.provider).toBe(s.provider);
            expect(h.events[0]?.model).toBe(s.model);
            expect(h.events[0]?.promptTokens).toBe(1);
            expect(h.events[0]?.completionTokens).toBe(2);
        });
    }
});

describe("parameterized wrappers — block path", () => {
    for (const s of scenarios) {
        test(`${s.label} throws BudgetExceededError before the provider call`, async () => {
            const h = buildHarness(BLOCK);
            await expect(s.invoke({ core: h.core, clientResponse: "ok" })).rejects.toBeInstanceOf(
                BudgetExceededError,
            );
            expect(h.events).toHaveLength(0);
        });
    }
});

describe("parameterized wrappers — provider error path", () => {
    for (const s of scenarios) {
        test(`${s.label} emits errored event and rethrows`, async () => {
            const h = buildHarness();
            await expect(s.invoke({ core: h.core, clientResponse: "error" })).rejects.toThrow(
                "boom",
            );
            expect(h.events).toHaveLength(1);
            expect(h.events[0]?.errored).toBe(true);
            expect(h.events[0]?.provider).toBe(s.provider);
        });
    }
});

describe("parameterized wrappers — fail-open", () => {
    for (const s of scenarios) {
        test(`${s.label} proceeds when decision is null`, async () => {
            const h = buildHarness(null);
            await s.invoke({ core: h.core, clientResponse: "ok" });
            expect(h.events).toHaveLength(1);
            expect(h.events[0]?.provider).toBe(s.provider);
        });
    }
});
