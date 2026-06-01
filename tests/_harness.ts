/**
 * Generic helpers shared by every platform slice. Keep this file
 * platform-agnostic: provider-specific fixtures (canned response bodies, SSE
 * payloads, model names) live inline in each platform test file so a
 * new platform never has to edit this shared file.
 *
 * Exports:
 *  - `buildFakeCore` — in-memory `BursoraCore` whose `decision.fetchDecision`
 *    returns a canned decision and whose `events.record` pushes to `events[]`.
 *  - `RecordedEvent` — the per-call shape pushed onto that array.
 *  - `recordingFetch` — a `fetch` stand-in that records each call and delegates
 *    to a caller-supplied impl (mirrors `tests/transport.test.ts`).
 *  - `RecordedFetchCall` — the per-call shape `recordingFetch` records.
 *  - `jsonResponse` — wraps a body in a JSON `Response` at the given status.
 *  - `sse` — the OpenAI-style data-frame builder (`data: {json}\n\n` … `[DONE]`).
 *  - `sseResponse` — wraps an SSE string in a `Response` with a byte
 *    `ReadableStream` body and `content-type: text/event-stream`.
 */

import type { EventInput, EventsClient } from "../src/internal/events";
import type { Decision } from "../src/types";
import type { BursoraCore, DecisionLookup } from "../src/wrap";

export type RecordedEvent = EventInput;

export interface FakeCore {
    readonly events: RecordedEvent[];
    readonly core: BursoraCore;
}

export function buildFakeCore(decision: Decision | null): FakeCore {
    const events: RecordedEvent[] = [];
    const decisionClient: DecisionLookup = {
        fetchDecision: async () => decision,
    };
    const eventsClient: EventsClient = {
        record: (e) => events.push(e),
        flush: async () => {},
    };
    const core: BursoraCore = {
        decision: decisionClient,
        events: eventsClient,
        now: () => 1_000,
        flush: async () => {},
        dispose: () => {},
    };
    return { events, core };
}

export interface RecordedFetchCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | undefined;
}

export function recordingFetch(
    calls: RecordedFetchCall[],
    impl: (call: RecordedFetchCall, init?: RequestInit) => Promise<Response>,
): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const call: RecordedFetchCall = {
            url: typeof input === "string" ? input : input.toString(),
            method: init?.method ?? "GET",
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === "string" ? init.body : undefined,
        };
        calls.push(call);
        return impl(call, init);
    }) as unknown as typeof fetch;
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

export function sse(...chunks: unknown[]): string {
    return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

export function sseResponse(body: string): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}
