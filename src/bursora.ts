/**
 * createBursora — single shared owner of decision cache + events queue.
 *
 * Most apps don't need to call this directly: `wrap(client, { apiKey, endpoint })`
 * constructs a private core for that wrapped client. Reach for `createBursora`
 * only when multiple wrapped clients need to share one decision cache and one
 * events queue, so `core.flush()` drains usage from every wrapped client in a
 * single request.
 *
 * Advanced: pass `decision` and/or `events` to plug a custom cache strategy
 * or batch sink (e.g. persisted queue, alternate transport). Anything you
 * don't supply is constructed from the default factories using `apiKey` and
 * `endpoint`. When both are supplied, `apiKey`/`endpoint` are not consulted.
 */

import { createDecisionClient, type DecisionClient } from "./internal/decision";
import { createEventsClient, type EventsClient, safeFlush } from "./internal/events";
import type { BursoraCore } from "./wrap";

/** @public */
export interface BursoraOptions {
    /**
     * Bursora API key. Required when the default `DecisionClient` or
     * `EventsQueue` will be constructed (i.e. when `decision` or `events` is
     * not supplied). Ignored when both adapters are caller-supplied.
     */
    readonly apiKey?: string;
    /**
     * Bursora endpoint (origin URL). Same requirement as `apiKey`: needed only
     * when a default adapter will be constructed.
     */
    readonly endpoint?: string;
    /**
     * Override the wall clock used for cache TTL math and event timestamps.
     * Default `() => Date.now()` re-reads `globalThis.Date.now` on each call,
     * so per-request clock mocks in sandboxed runtimes (Workers, isolates) are
     * respected without injecting anything. Pass an explicit clock when the
     * host monkey-patches `Date` in a way that prevents that lookup.
     */
    readonly clock?: () => number;
    /**
     * Caller-supplied decision client. Overrides the default in-process LRU
     * client. Construct via `createDecisionClient` or supply any object that
     * satisfies the `DecisionClient` shape (e.g. a Redis-backed cache).
     */
    readonly decision?: DecisionClient;
    /**
     * Caller-supplied events queue. Overrides the default batching client.
     * Construct via `createEventsQueue` or supply any object that satisfies
     * the `EventsQueue` shape (e.g. a persisted queue, S3 archiver).
     */
    readonly events?: EventsClient;
}

/** @internal SDK internals; not part of the stable public API. */
export type { BursoraCore } from "./wrap";

export function createBursora(opts: BursoraOptions): BursoraCore {
    const now = opts.clock ?? ((): number => Date.now());
    const decision =
        opts.decision ?? createDecisionClient({ ...requireCreds(opts), cacheCapacity: 128, now });
    const events = opts.events ?? createEventsClient(requireCreds(opts));

    return {
        decision,
        events,
        now,
        flush: () => safeFlush(events),
        dispose: () => events.dispose?.(),
    };
}

function requireCreds(opts: BursoraOptions): { apiKey: string; endpoint: string } {
    if (opts.apiKey === undefined || opts.apiKey === "") {
        throw new Error("createBursora: apiKey is required");
    }
    if (opts.endpoint === undefined || opts.endpoint === "") {
        throw new Error("createBursora: endpoint is required");
    }
    return { apiKey: opts.apiKey, endpoint: opts.endpoint };
}
