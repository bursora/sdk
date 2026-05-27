/**
 * createBursora — single shared owner of decision cache + events queue.
 *
 * Most apps don't need to call this directly: `wrap(client, { apiKey, endpoint })`
 * constructs a private core for that wrapped client. Reach for `createBursora`
 * only when multiple wrapped clients need to share one decision cache and one
 * events queue, so `core.flush()` drains usage from every wrapped client in a
 * single request.
 */

import { createDecisionClient } from "./internal/decision";
import { createEventsClient, safeFlush } from "./internal/events";
import type { BursoraCore } from "./wrap";

export interface BursoraOptions {
    readonly apiKey: string;
    readonly endpoint: string;
    /**
     * Override the wall clock used for cache TTL math and event timestamps.
     * Default `() => Date.now()` re-reads `globalThis.Date.now` on each call,
     * so per-request clock mocks in sandboxed runtimes (Workers, isolates) are
     * respected without injecting anything. Pass an explicit clock when the
     * host monkey-patches `Date` in a way that prevents that lookup.
     */
    readonly clock?: () => number;
}

export type { BursoraCore } from "./wrap";

export function createBursora(opts: BursoraOptions): BursoraCore {
    if (opts.apiKey === "") throw new Error("createBursora: apiKey is required");
    if (opts.endpoint === "") throw new Error("createBursora: endpoint is required");
    const now = opts.clock ?? ((): number => Date.now());
    const decision = createDecisionClient({
        apiKey: opts.apiKey,
        endpoint: opts.endpoint,
        cacheCapacity: 128,
        now,
    });
    const events = createEventsClient({
        apiKey: opts.apiKey,
        endpoint: opts.endpoint,
    });

    return {
        decision,
        events,
        now,
        flush: () => safeFlush(events),
        dispose: events.dispose,
    };
}
