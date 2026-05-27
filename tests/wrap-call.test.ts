/**
 * wrapClient — deep module that wraps a provider method with the decision
 * lifecycle. Per-call sequence (SPEC §6.3):
 *
 *   1. Read tags from AsyncLocalStorage
 *   2. Decision lookup (cache first, then fetch)
 *   3. If !allow && mode === 'block' → throw BudgetExceededError BEFORE call
 *   4. Call provider (success or error)
 *   5. Emit usage event
 *
 * Failure modes:
 *   - decision endpoint 5xx → fail open, proceed with provider call
 *   - ingest endpoint 5xx → swallow, do not throw to consumer
 *   - provider error → emit event, rethrow
 *   - streaming → wrap iterator, emit on stream end
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";
import { wrapCall } from "../src/internal/wrap-call";
import { withTags } from "../src/tags";
import type { Decision, UsageTotals } from "../src/types";

interface FakeArgs {
    readonly model: string;
    readonly stream?: boolean;
}
interface FakeResponse {
    readonly id: string;
    readonly usage: { prompt_tokens: number; completion_tokens: number };
}

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };
const BLOCK: Decision = { allow: false, mode: "block", reason: "cap", ttl_s: 60 };

interface RecordedEvent {
    readonly provider: string;
    readonly model: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly tenantId?: string | null;
    readonly agentId?: string | null;
    readonly workflowId?: string | null;
    readonly errored?: boolean;
}

const buildHarness = (overrides: {
    decision?: Decision | null;
    decisionThrows?: boolean;
    ingestThrows?: boolean;
}) => {
    const decisionCalls: string[] = [];
    const events: RecordedEvent[] = [];
    const logs: string[] = [];
    let flushed = false;

    const decisionClient = {
        fetchDecision: async (tags: Record<string, string | undefined>) => {
            decisionCalls.push(JSON.stringify(tags));
            if (overrides.decisionThrows) return null;
            return overrides.decision === undefined ? ALLOW : overrides.decision;
        },
    };
    const eventsClient = {
        record: (event: RecordedEvent) => {
            events.push(event);
        },
        flush: async () => {
            flushed = true;
            if (overrides.ingestThrows) {
                // simulate fail-open: client absorbs the error
                logs.push("bursora_ingest_unavailable");
            }
        },
    };
    return { decisionClient, eventsClient, decisionCalls, events, logs, flushed: () => flushed };
};

const extractCallMeta = (args: FakeArgs) => ({
    provider: "openai",
    model: args.model,
    isStream: args.stream === true,
});

const extractUsage = (response: FakeResponse): UsageTotals => ({
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
});

describe("wrapCall — success path", () => {
    test("calls the provider when decision is allow", async () => {
        const h = buildHarness({});
        let providerCalled = 0;
        const wrapped = wrapCall(
            async (_args: FakeArgs) => {
                providerCalled += 1;
                return {
                    id: "r1",
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                } satisfies FakeResponse;
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        const out = await wrapped({ model: "gpt-4o" });
        expect(out.id).toBe("r1");
        expect(providerCalled).toBe(1);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(10);
        expect(h.events[0]?.completionTokens).toBe(5);
        expect(h.events[0]?.errored).toBeFalsy();
    });

    test("propagates AsyncLocalStorage tags into decision lookup + event", async () => {
        const h = buildHarness({});
        const wrapped = wrapCall(
            async () =>
                ({
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 2 },
                }) satisfies FakeResponse,
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await withTags({ tenant_id: "acme", agent_id: "support" }, async () => {
            await wrapped({ model: "gpt-4o" });
        });
        expect(h.decisionCalls[0]).toContain("acme");
        expect(h.decisionCalls[0]).toContain("support");
        expect(h.events[0]?.tenantId).toBe("acme");
        expect(h.events[0]?.agentId).toBe("support");
    });
});

describe("wrapCall — block path", () => {
    test("throws BudgetExceededError BEFORE calling the provider", async () => {
        const h = buildHarness({ decision: BLOCK });
        let providerCalled = 0;
        const wrapped = wrapCall(
            async (_args: FakeArgs) => {
                providerCalled += 1;
                return {
                    id: "r1",
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                } satisfies FakeResponse;
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await expect(
            withTags({ tenant_id: "acme" }, async () => wrapped({ model: "gpt-4o" })),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        expect(providerCalled).toBe(0);
        expect(h.events).toHaveLength(0);
    });

    test("BudgetExceededError carries the offending tag and reason", async () => {
        const h = buildHarness({ decision: BLOCK });
        const wrapped = wrapCall(
            async () =>
                ({
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }) satisfies FakeResponse,
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        try {
            await withTags({ tenant_id: "acme" }, async () => wrapped({ model: "gpt-4o" }));
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(BudgetExceededError);
            const e = err as BudgetExceededError;
            expect(e.reason).toBe("cap");
            expect(e.mode).toBe("block");
            expect(e.tag).toEqual({ tenant_id: "acme" });
        }
    });

    test("notify mode does NOT block even when allow=false", async () => {
        const h = buildHarness({
            decision: { allow: false, mode: "notify", reason: "warn", ttl_s: 60 },
        });
        let providerCalled = 0;
        const wrapped = wrapCall(
            async () => {
                providerCalled += 1;
                return {
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                } satisfies FakeResponse;
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await wrapped({ model: "gpt-4o" });
        expect(providerCalled).toBe(1);
    });
});

describe("wrapCall — provider error path", () => {
    test("emits an event with errored=true and rethrows the original error", async () => {
        const h = buildHarness({});
        const wrapped = wrapCall(
            async () => {
                throw new Error("provider boom");
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await expect(wrapped({ model: "gpt-4o" })).rejects.toThrow("provider boom");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
        expect(h.events[0]?.promptTokens).toBe(0);
        expect(h.events[0]?.completionTokens).toBe(0);
    });

    test("preserves error identity when event recording throws synchronously", async () => {
        class ProviderError extends Error {
            constructor(message: string) {
                super(message);
                this.name = "ProviderError";
            }
        }
        const originalError = new ProviderError("provider boom");
        const originalStack = originalError.stack;

        const eventsClient = {
            record: () => {
                throw new Error("recording sink exploded");
            },
            flush: async () => {},
        };
        const decisionClient = {
            fetchDecision: async () => ALLOW,
        };

        const wrapped = wrapCall(
            async () => {
                throw originalError;
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient,
                eventsClient,
                now: () => 1_000,
            },
        );

        let caught: unknown = null;
        try {
            await wrapped({ model: "gpt-4o" });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(originalError);
        expect(caught).toBeInstanceOf(ProviderError);
        expect((caught as Error).stack).toBe(originalStack);
        expect((caught as Error).message).toBe("provider boom");
    });
});

describe("wrapCall — fail-open semantics", () => {
    test("decision returning null still calls provider (server unavailable)", async () => {
        const h = buildHarness({ decision: null });
        let providerCalled = 0;
        const wrapped = wrapCall(
            async () => {
                providerCalled += 1;
                return {
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                } satisfies FakeResponse;
            },
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await wrapped({ model: "gpt-4o" });
        expect(providerCalled).toBe(1);
        expect(h.events).toHaveLength(1);
    });

    test("ingest flush failure does not surface to consumer", async () => {
        const h = buildHarness({ ingestThrows: true });
        const wrapped = wrapCall(
            async () =>
                ({
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }) satisfies FakeResponse,
            {
                extractCallMeta,
                extractUsage,
                decisionClient: h.decisionClient,
                eventsClient: h.eventsClient,
                now: () => 1_000,
            },
        );
        await expect(wrapped({ model: "gpt-4o" })).resolves.toMatchObject({
            id: "r1",
        });
    });
});

describe("wrapCall — streaming", () => {
    test("returns the underlying iterator and emits event on stream completion", async () => {
        const h = buildHarness({});
        const chunks = [
            { choices: [{ delta: { content: "h" } }], usage: null },
            { choices: [{ delta: { content: "i" } }], usage: null },
            // final chunk carries usage
            {
                choices: [{ delta: { content: "" } }],
                usage: { prompt_tokens: 7, completion_tokens: 3 },
            },
        ];
        const stream = (async function* () {
            for (const c of chunks) yield c;
        })();
        const wrapped = wrapCall(async () => stream, {
            extractCallMeta: (args: FakeArgs) => ({
                provider: "openai",
                model: args.model,
                isStream: true,
            }),
            extractUsage: () => ({
                promptTokens: 0,
                completionTokens: 0,
            }),
            createStreamHandler: () => (chunk: unknown) => {
                const u = (
                    chunk as { usage: { prompt_tokens: number; completion_tokens: number } | null }
                ).usage;
                return u
                    ? {
                          promptTokensDelta: u.prompt_tokens,
                          completionTokensDelta: u.completion_tokens,
                      }
                    : null;
            },
            decisionClient: h.decisionClient,
            eventsClient: h.eventsClient,
            now: () => 1_000,
        });
        const iter = await wrapped({ model: "gpt-4o", stream: true });
        const collected = [];
        for await (const chunk of iter as AsyncIterable<unknown>) {
            collected.push(chunk);
        }
        expect(collected).toHaveLength(3);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.promptTokens).toBe(7);
        expect(h.events[0]?.completionTokens).toBe(3);
    });

    test("streaming pass-through does not buffer the body", async () => {
        const h = buildHarness({});
        const yielded: string[] = [];
        const consumed: string[] = [];
        async function* producer() {
            for (const tag of ["a", "b", "c"]) {
                yielded.push(tag);
                yield { tag, usage: null };
            }
            yield {
                tag: "end",
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
        }
        const wrapped = wrapCall(async () => producer(), {
            extractCallMeta: () => ({
                provider: "openai",
                model: "gpt-4o",
                isStream: true,
            }),
            extractUsage: () => ({
                promptTokens: 0,
                completionTokens: 0,
            }),
            createStreamHandler: () => (chunk: unknown) => {
                const u = (
                    chunk as { usage: { prompt_tokens: number; completion_tokens: number } | null }
                ).usage;
                return u
                    ? {
                          promptTokensDelta: u.prompt_tokens,
                          completionTokensDelta: u.completion_tokens,
                      }
                    : null;
            },
            decisionClient: h.decisionClient,
            eventsClient: h.eventsClient,
            now: () => 1_000,
        });
        const iter = (await wrapped({ model: "gpt-4o", stream: true })) as AsyncIterable<{
            tag: string;
        }>;
        for await (const chunk of iter) {
            consumed.push(chunk.tag);
            // After each consumed chunk, the producer should only have yielded up to here.
            expect(yielded.length).toBeLessThanOrEqual(consumed.length + 1);
        }
        expect(consumed).toEqual(["a", "b", "c", "end"]);
    });

    test("streaming error path emits event with errored=true", async () => {
        const h = buildHarness({});
        async function* producer() {
            yield { usage: null };
            throw new Error("stream interrupted");
        }
        const wrapped = wrapCall(async () => producer(), {
            extractCallMeta: () => ({
                provider: "openai",
                model: "gpt-4o",
                isStream: true,
            }),
            extractUsage: () => ({
                promptTokens: 0,
                completionTokens: 0,
            }),
            createStreamHandler: () => () => null,
            decisionClient: h.decisionClient,
            eventsClient: h.eventsClient,
            now: () => 1_000,
        });
        const iter = (await wrapped({
            model: "gpt-4o",
            stream: true,
        })) as AsyncIterable<unknown>;
        let caught: unknown = null;
        try {
            for await (const _c of iter) void _c;
        } catch (e) {
            caught = e;
        }
        expect((caught as Error).message).toBe("stream interrupted");
        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.errored).toBe(true);
    });

    test("throws a clear error when isStream=true but response is not async iterable", async () => {
        const h = buildHarness({});
        // Provider returns a plain object even though the call was marked as a stream.
        // The wrapper must detect this and throw a descriptive error instead of
        // silently casting and crashing on the consumer's first `for await`.
        const wrapped = wrapCall(async () => ({ id: "not-a-stream" }) as unknown, {
            extractCallMeta: () => ({
                provider: "openai",
                model: "gpt-4o",
                isStream: true,
            }),
            extractUsage: () => ({
                promptTokens: 0,
                completionTokens: 0,
            }),
            createStreamHandler: () => () => null,
            decisionClient: h.decisionClient,
            eventsClient: h.eventsClient,
            now: () => 1_000,
        });
        await expect(wrapped({ model: "gpt-4o", stream: true })).rejects.toThrow(/stream/i);
    });
});

describe("wrapCall — per-scope flush serialization", () => {
    test("second concurrent call's decision lookup observes the first call's flushed event", async () => {
        // Two concurrent calls on the same scope race. Without serialization,
        // call B's decision lookup runs before call A's flush settles; the
        // server then computes B's budget from a stale snapshot.
        let flushedCount = 0;
        const decisionFlushSnapshots: number[] = [];
        const events: RecordedEvent[] = [];

        const decisionClient = {
            fetchDecision: async (_tags: Record<string, string | undefined>) => {
                decisionFlushSnapshots.push(flushedCount);
                return ALLOW;
            },
        };
        const eventsClient = {
            record: (event: RecordedEvent) => {
                events.push(event);
            },
            flush: async () => {
                // Yield a couple of microtasks so a concurrent caller has a
                // real chance to interleave past us — emulates real network
                // POST latency without timers.
                await Promise.resolve();
                await Promise.resolve();
                flushedCount += 1;
            },
        };

        const wrapped = wrapCall(
            async (_args: FakeArgs) =>
                ({
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }) satisfies FakeResponse,
            {
                extractCallMeta,
                extractUsage,
                decisionClient,
                eventsClient,
                now: () => 1_000,
            },
        );

        await withTags({ tenant_id: "acme" }, async () => {
            await Promise.all([wrapped({ model: "gpt-4o" }), wrapped({ model: "gpt-4o" })]);
        });

        expect(decisionFlushSnapshots).toHaveLength(2);
        expect(events).toHaveLength(2);
        // First call runs before any flush has completed.
        expect(decisionFlushSnapshots[0]).toBe(0);
        // Second call must see the first call's flush already settled.
        expect(decisionFlushSnapshots[1]).toBe(1);
    });

    test("does not serialize across different scopes", async () => {
        // Lock is scoped per tenant/agent/workflow. Concurrent calls on
        // different scopes must proceed in parallel — otherwise per-call
        // latency stacks linearly across unrelated tenants.
        const startedDecisions: string[] = [];
        const resolveDecision: Record<string, () => void> = {};
        const decisionClient = {
            fetchDecision: async (tags: Record<string, string | undefined>) => {
                const key = tags.tenant_id ?? "";
                startedDecisions.push(key);
                // Block until the test releases this scope.
                await new Promise<void>((res) => {
                    resolveDecision[key] = res;
                });
                return ALLOW;
            },
        };
        const eventsClient = {
            record: () => {},
            flush: async () => {},
        };

        const wrapped = wrapCall(
            async (_args: FakeArgs) =>
                ({
                    id: "r1",
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }) satisfies FakeResponse,
            {
                extractCallMeta,
                extractUsage,
                decisionClient,
                eventsClient,
                now: () => 1_000,
            },
        );

        const a = withTags({ tenant_id: "acme" }, async () => wrapped({ model: "gpt-4o" }));
        const b = withTags({ tenant_id: "globex" }, async () => wrapped({ model: "gpt-4o" }));
        // Let both calls reach the blocked decision fetch.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Both scopes must be in-flight in parallel; the lock is per-scope.
        expect(startedDecisions.sort()).toEqual(["acme", "globex"]);

        resolveDecision.acme?.();
        resolveDecision.globex?.();
        await Promise.all([a, b]);
    });
});
