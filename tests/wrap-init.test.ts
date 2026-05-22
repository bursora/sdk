/**
 * wrap(client, { apiKey, endpoint }) — single-call init.
 *
 * The 2-arg `wrap()` accepts either a pre-built `BursoraCore` or a plain
 * options object `{ apiKey, endpoint }`. In the options-object path the
 * SDK builds a private core for this wrapped client. These tests pin:
 *   - decision lookup hits the configured endpoint with the configured key
 *   - usage events are queued and drained by `flush()` on the wrapped client
 *   - `dispose()` releases the internal events client's `beforeExit` slot
 *   - invalid options throw the same way as `createBursora` does directly
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __pruneLiveClients } from "../src/internal/events";
import type { Decision } from "../src/types";
import { wrap } from "../src/wrap";

const ALLOW: Decision = { allow: true, mode: "notify", reason: "ok", ttl_s: 60 };

const API_KEY = "bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const ENDPOINT = "https://app.bursora.com";

let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

function stubFetch(impl: typeof fetch): void {
    globalThis.fetch = impl;
}

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

describe("wrap(client, { apiKey, endpoint }) — inline init", () => {
    test("hits /api/v1/budget then /api/v1/events with the configured key", async () => {
        const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
        stubFetch(((url: string | URL | Request, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString();
            const h = (init?.headers ?? {}) as Record<string, string>;
            calls.push({ url: u, headers: h, body: String(init?.body ?? "") });
            if (u.includes("/api/v1/budget")) {
                return Promise.resolve(
                    new Response(JSON.stringify(ALLOW), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }
            return Promise.resolve(new Response("", { status: 202 }));
        }) as unknown as typeof fetch);

        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });

        await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
        await openai.flush();

        const budgetCall = calls.find((c) => c.url.includes("/api/v1/budget"));
        const eventsCall = calls.find((c) => c.url.includes("/api/v1/events"));
        expect(budgetCall).toBeDefined();
        expect(eventsCall).toBeDefined();
        expect(budgetCall?.headers["x-bursora-key"]).toBe(API_KEY);
        expect(eventsCall?.headers["x-bursora-key"]).toBe(API_KEY);
        expect(eventsCall?.body).toContain('"provider":"openai"');

        openai.dispose();
    });

    test("dispose() releases the internal events client's beforeExit slot", async () => {
        __pruneLiveClients();
        stubFetch((async () => new Response("", { status: 202 })) as unknown as typeof fetch);

        const openai = wrap(openaiClient(), { apiKey: API_KEY, endpoint: ENDPOINT });
        openai.dispose();

        const handler = process
            .listeners("beforeExit")
            .find((l) => l.name === "bursoraDrainOnBeforeExit") as
            | ((code: number) => unknown)
            | undefined;
        if (handler !== undefined) await Promise.resolve(handler(0));

        expect(__pruneLiveClients()).toBe(0);
    });

    test("throws when apiKey is empty", () => {
        expect(() => wrap(openaiClient(), { apiKey: "", endpoint: ENDPOINT })).toThrow(
            /apiKey is required/,
        );
    });

    test("throws when endpoint is empty", () => {
        expect(() => wrap(openaiClient(), { apiKey: API_KEY, endpoint: "" })).toThrow(
            /endpoint is required/,
        );
    });
});
