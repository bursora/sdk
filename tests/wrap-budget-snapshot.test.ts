/**
 * Budget headroom snapshot exposed on `wrap(client).budget`.
 *
 * The wrapped client carries a read-only snapshot of the most recent decision's
 * `remainingUsd` and `resetAt`. Customer apps read it between calls to
 * self-degrade upstream (skip optional calls, swap to cache, batch) before any
 * block fires. The snapshot starts as `null` and updates after every successful
 * decision fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Decision } from "../src/types";
import { wrap } from "../src/wrap";

const API_KEY = "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const ENDPOINT = "https://app.bursora.com";

let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    console.warn = () => {};
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
});

const openaiClient = () => ({
    chat: {
        completions: {
            create: async (_args: unknown) => ({
                id: "c1",
                model: "gpt-4o-mini",
                usage: { prompt_tokens: 2, completion_tokens: 3 },
            }),
        },
    },
    embeddings: { create: async (_args: unknown) => ({}) },
});

const stubBudgetResponse = (decision: Decision): void => {
    globalThis.fetch = ((url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/v1/budget")) {
            return Promise.resolve(
                new Response(JSON.stringify(decision), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }
        return Promise.resolve(new Response("", { status: 202 }));
    }) as unknown as typeof fetch;
};

describe("wrap(client).budget snapshot", () => {
    test("returns null before the first wrapped call", () => {
        stubBudgetResponse({
            allow: true,
            mode: "notify",
            reason: "ok",
            ttl_s: 60,
            remainingUsd: 50,
            resetAt: "2025-05-11T00:00:00.000Z",
        });
        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            expect(openai.budget).toBeNull();
        } finally {
            openai.dispose();
        }
    });

    test("reflects the latest decision's remainingUsd and resetAt after a wrapped call", async () => {
        stubBudgetResponse({
            allow: true,
            mode: "notify",
            reason: "under:workspace:*:25/100",
            ttl_s: 60,
            remainingUsd: 75,
            resetAt: "2025-05-11T00:00:00.000Z",
        });
        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(openai.budget).toEqual({
                remainingUsd: 75,
                resetAt: "2025-05-11T00:00:00.000Z",
            });
        } finally {
            openai.dispose();
        }
    });

    test("stays null after a wrapped call when the server omits both fields (old server)", async () => {
        stubBudgetResponse({
            allow: true,
            mode: "notify",
            reason: "ok",
            ttl_s: 60,
        });
        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(openai.budget).toBeNull();
        } finally {
            openai.dispose();
        }
    });

    test("stays null when the server returns the empty-string resetAt sentinel (no budgets)", async () => {
        stubBudgetResponse({
            allow: true,
            mode: "notify",
            reason: "no_budget",
            ttl_s: 60,
            remainingUsd: 0,
            resetAt: "",
        });
        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(openai.budget).toBeNull();
        } finally {
            openai.dispose();
        }
    });

    test("preserves the last-known-good snapshot when a later call omits the fields (old server)", async () => {
        let firstCall = true;
        globalThis.fetch = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.includes("/api/v1/budget")) {
                const body = firstCall
                    ? {
                          allow: true,
                          mode: "notify",
                          reason: "under",
                          ttl_s: 0,
                          remainingUsd: 75,
                          resetAt: "2025-05-11T00:00:00.000Z",
                      }
                    : {
                          // Old server shape: no remainingUsd / resetAt.
                          allow: true,
                          mode: "notify",
                          reason: "ok",
                          ttl_s: 0,
                      };
                firstCall = false;
                return Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch;

        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(openai.budget).toEqual({
                remainingUsd: 75,
                resetAt: "2025-05-11T00:00:00.000Z",
            });

            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi again" }],
            });
            // Second call returned no fields — snapshot must stay the prior value.
            expect(openai.budget).toEqual({
                remainingUsd: 75,
                resetAt: "2025-05-11T00:00:00.000Z",
            });
        } finally {
            openai.dispose();
        }
    });

    test("keeps the same snapshot reference across calls that hit the decision cache, and replaces it on a fresh fetch", async () => {
        // Asserts the "fresh-only write" contract: latestSnapshot must only be
        // reassigned on a cache miss (or version bump). Without this, every
        // cache-hit lookup rewrites latestSnapshot to a new object built from
        // the same stale decision, and consumers reading `budget` see the
        // headroom flicker even though nothing changed on the server.
        let now = 1_000;
        let fetchCount = 0;
        globalThis.fetch = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.includes("/api/v1/budget")) {
                fetchCount += 1;
                const body = fetchCount === 1
                    ? {
                          allow: true,
                          mode: "notify",
                          reason: "under:workspace:*:25/100",
                          ttl_s: 60,
                          remainingUsd: 75,
                          resetAt: "2025-05-11T00:00:00.000Z",
                      }
                    : {
                          allow: true,
                          mode: "notify",
                          reason: "under:workspace:*:30/100",
                          ttl_s: 60,
                          remainingUsd: 70,
                          resetAt: "2025-05-11T00:00:00.000Z",
                      };
                return Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch;

        const openai = wrap(openaiClient(), {
            apiKey: API_KEY,
            endpoint: ENDPOINT,
            clock: () => now,
        });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            const afterFirst = openai.budget;
            expect(afterFirst).toEqual({
                remainingUsd: 75,
                resetAt: "2025-05-11T00:00:00.000Z",
            });

            // Still inside ttl_s window — second call is a cache hit on the
            // decision client. Snapshot must NOT be reassigned: reference
            // stability is the observable proof.
            now = 30_000;
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi again" }],
            });
            expect(fetchCount).toBe(1);
            expect(openai.budget).toBe(afterFirst);

            // Past ttl_s — next call refetches and snapshot reflects the new
            // decision. Reference must change.
            now = 1_000 + 61_000;
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi yet again" }],
            });
            expect(fetchCount).toBe(2);
            expect(openai.budget).not.toBe(afterFirst);
            expect(openai.budget).toEqual({
                remainingUsd: 70,
                resetAt: "2025-05-11T00:00:00.000Z",
            });
        } finally {
            openai.dispose();
        }
    });

    test("updates when a later call returns a different snapshot", async () => {
        let firstCall = true;
        globalThis.fetch = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.includes("/api/v1/budget")) {
                const body = firstCall
                    ? {
                          allow: true,
                          mode: "notify",
                          reason: "under",
                          ttl_s: 0,
                          remainingUsd: 75,
                          resetAt: "2025-05-11T00:00:00.000Z",
                      }
                    : {
                          allow: true,
                          mode: "throttle",
                          reason: "tenant:acme:over:11/10",
                          ttl_s: 0,
                          remainingUsd: 0,
                          resetAt: "2025-05-11T00:00:00.000Z",
                      };
                firstCall = false;
                return Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch;

        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        try {
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(openai.budget?.remainingUsd).toBe(75);

            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi again" }],
            });
            expect(openai.budget?.remainingUsd).toBe(0);
        } finally {
            openai.dispose();
        }
    });
});
