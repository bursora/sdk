/**
 * Shared cumulative-usage stream handler.
 *
 * OpenAI- and Gemini-style streams both report usage as CUMULATIVE running
 * totals — typically on a terminal chunk, while intermediate chunks may carry
 * partial usage or none. This factory owns the latest-wins delta math both
 * need: track the latest seen totals and emit each chunk's delta against the
 * last emitted figure, so the engine's sum-of-deltas equals the final totals.
 * Cache is subtracted from prompt at emit time (not per raw field) so a
 * cache-only chunk arriving before any prompt chunk can't underflow
 * promptTokens.
 *
 * Vendors differ only in field names, so each passes an `extract` that reads a
 * raw chunk into the cumulative totals it carries. A `undefined` field means
 * "this chunk didn't report it — keep the prior total"; `hasUsage` is the
 * vendor's own "did this chunk carry a usage object at all" verdict (vendors
 * disagree on whether a null usage counts), used with `requestId` to decide
 * when a chunk is inert and should emit no delta.
 */

import type { UsageDelta } from "../types";

export interface ChunkReading {
    /** Cumulative prompt total (cache included); `undefined` if not in this chunk. */
    readonly prompt: number | undefined;
    /** Cumulative completion total; `undefined` if not in this chunk. */
    readonly completion: number | undefined;
    /** Cumulative cached-prompt total; `undefined` if not in this chunk. */
    readonly cache: number | undefined;
    /** Request id carried on this chunk; `undefined` if none. */
    readonly requestId: string | undefined;
    /** Whether this chunk carried a usage object at all (vendor's own rule). */
    readonly hasUsage: boolean;
}

export function createCumulativeStreamHandler(
    extract: (chunk: unknown) => ChunkReading,
): (chunk: unknown) => UsageDelta | null {
    let promptTotal = 0;
    let completionTotal = 0;
    let cacheTotal = 0;
    let lastEmittedPromptUncached = 0;
    let lastEmittedCompletion = 0;
    let lastEmittedCache = 0;
    let requestId: string | undefined;

    return (raw: unknown) => {
        const r = extract(raw);
        if (requestId === undefined && r.requestId !== undefined) requestId = r.requestId;
        if (!r.hasUsage && r.requestId === undefined) return null;

        if (r.prompt !== undefined) promptTotal = r.prompt;
        if (r.completion !== undefined) completionTotal = r.completion;
        if (r.cache !== undefined) cacheTotal = r.cache;

        const promptUncached = Math.max(0, promptTotal - cacheTotal);
        const promptDelta = promptUncached - lastEmittedPromptUncached;
        const completionDelta = completionTotal - lastEmittedCompletion;
        const cacheDelta = cacheTotal - lastEmittedCache;
        lastEmittedPromptUncached = promptUncached;
        lastEmittedCompletion = completionTotal;
        lastEmittedCache = cacheTotal;

        return {
            promptTokensDelta: promptDelta,
            completionTokensDelta: completionDelta,
            ...(cacheDelta !== 0 ? { cacheTokensDelta: cacheDelta } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
        };
    };
}
