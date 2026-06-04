/**
 * wrapCall — per-method call lifecycle engine.
 *
 * Wraps a single async provider call with:
 *   1. Tag read from AsyncLocalStorage
 *   2. Decision lookup; block-mode rejection before the call
 *   3. Provider invocation (sync response or async iterable stream)
 *   4. Usage event emission (success or errored), then fire-and-forget flush
 *
 * The manifest-driven `wrap()` in `../wrap.ts` composes one wrapped call per
 * method spec; `wrapCall` itself stays generic over Args/Response so the same
 * engine handles every provider.
 */

import { currentTags } from "../tags";
import type { EventStreamHooks, Tags, UsageDelta, UsageTotals } from "../types";
import { type EventsClient, safeFlush } from "./events";
import { buildEventInput, type DecisionLookup, preflightGate } from "./lifecycle";

/** @internal Re-exported from `./lifecycle`; kept here for back-compat imports. */
export type { DecisionLookup } from "./lifecycle";

interface CallMeta {
    readonly provider: string;
    readonly model: string;
    readonly isStream: boolean;
}

export type StreamChunkHandler = (chunk: unknown) => UsageDelta | null;

export interface WrapCallOptions<Args, Response> {
    readonly extractCallMeta: (args: Args) => CallMeta;
    readonly extractUsage: (response: Response) => UsageTotals;
    readonly createStreamHandler?: () => StreamChunkHandler;
    readonly decisionClient: DecisionLookup;
    readonly eventsClient: EventsClient;
    readonly now: () => number;
}

export function wrapCall<Args, Response>(
    call: (args: Args) => Promise<Response>,
    opts: WrapCallOptions<Args, Response>,
): (args: Args) => Promise<Response> {
    return async (args: Args): Promise<Response> => {
        const tags = currentTags();
        const meta = opts.extractCallMeta(args);

        await preflightGate(opts.decisionClient, tags, {
            provider: meta.provider,
            model: meta.model,
        });

        const startedAt = opts.now();
        let response: Response;
        try {
            response = await call(args);
        } catch (err) {
            // Capture the original reference up-front. A buggy `record` sink
            // could throw or mutate the error; the caller's `instanceof` and
            // stack must survive that. Always rethrow the original.
            const originalError = err;
            try {
                opts.eventsClient.record(
                    buildEventInput(meta, tags, startedAt, opts.now(), null, true),
                );
            } catch {
                // swallow: recording must not poison the rethrow path
            }
            await safeFlush(opts.eventsClient);
            throw originalError;
        }

        if (meta.isStream) {
            const handler = opts.createStreamHandler?.();
            return wrapStream<Response>(
                response,
                meta,
                tags,
                handler,
                opts.eventsClient,
                opts.now,
                startedAt,
            );
        }

        const usage = opts.extractUsage(response);
        opts.eventsClient.record(buildEventInput(meta, tags, startedAt, opts.now(), usage, false));
        // Await: cost must commit before next preflight so block budgets stop
        // the next call once cumulative spend crosses the cap.
        await safeFlush(opts.eventsClient);
        return response;
    };
}

export interface WrapEventStreamOptions<Args> {
    readonly extractCallMeta: (args: Args) => CallMeta;
    readonly createStreamHandler?: () => StreamChunkHandler;
    readonly attachEventStream: (stream: object, hooks: EventStreamHooks) => void;
    readonly eventsClient: EventsClient;
    readonly now: () => number;
}

/**
 * Wraps a synchronous, event-emitting stream method (Anthropic's
 * `messages.stream()` → `MessageStream`). Unlike `wrapCall`, this never awaits:
 * the provider method fires its request synchronously, so there is no seam to
 * run a block gate before it — the call is metered, not pre-gated. The returned
 * stream object is handed back untouched; usage is captured by listeners the
 * provider attaches via `attachEventStream`, which feeds chunks through
 * `onChunk` and signals completion once through `onSettle`.
 */
export function wrapEventStreamCall<Args, Response>(
    call: (args: Args) => Response,
    opts: WrapEventStreamOptions<Args>,
): (args: Args) => Response {
    return (args: Args): Response => {
        const tags = currentTags();
        const meta = opts.extractCallMeta(args);
        const startedAt = opts.now();
        const stream = call(args);

        const handler = opts.createStreamHandler?.();
        let prompt = 0;
        let completion = 0;
        let cache = 0;
        let cacheWrite = 0;
        let requestId: string | undefined;
        let settled = false;

        opts.attachEventStream(stream as object, {
            onChunk: (raw: unknown): void => {
                if (handler === undefined) return;
                let delta: UsageDelta | null;
                try {
                    delta = handler(raw);
                } catch {
                    // A throwing handler must never poison the user's stream;
                    // drop the chunk and keep the totals as-is.
                    return;
                }
                if (delta === null) return;
                prompt += delta.promptTokensDelta;
                completion += delta.completionTokensDelta;
                cache += delta.cacheTokensDelta ?? 0;
                cacheWrite += delta.cacheWriteTokensDelta ?? 0;
                if (requestId === undefined && delta.requestId !== undefined) {
                    requestId = delta.requestId;
                }
            },
            // Settle once: the terminal `end` fires after every chunk, and after
            // `error`/`abort` (which chain into it), so the first signal wins and
            // any later `end` is ignored.
            onSettle: (errored: boolean): void => {
                if (settled) return;
                settled = true;
                opts.eventsClient.record(
                    buildEventInput(
                        meta,
                        tags,
                        startedAt,
                        opts.now(),
                        {
                            promptTokens: prompt,
                            completionTokens: completion,
                            ...(cache > 0 ? { cacheTokens: cache } : {}),
                            ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
                            ...(requestId !== undefined ? { requestId } : {}),
                        },
                        errored,
                    ),
                );
                // Can't await in a sync listener; the queued event flushes
                // best-effort, mirroring the non-stream path's commit.
                void safeFlush(opts.eventsClient);
            },
        });

        return stream;
    };
}

function isAsyncIterable<T>(x: unknown): x is AsyncIterable<T> {
    return (
        typeof x === "object" &&
        x !== null &&
        typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
    );
}

function wrapStream<Response>(
    source: Response,
    meta: CallMeta,
    tags: Tags,
    streamHandler: StreamChunkHandler | undefined,
    eventsClient: EventsClient,
    now: () => number,
    startedAt: number,
): Response {
    if (!isAsyncIterable<unknown>(source)) {
        throw new TypeError(
            `bursora: ${meta.provider}.${meta.model} was wrapped as a stream but the provider returned a non-iterable value`,
        );
    }
    const iterable = source;
    let prompt = 0;
    let completion = 0;
    let cache = 0;
    let cacheWrite = 0;
    let requestId: string | undefined;
    let emitted = false;

    const finalize = async (errored: boolean): Promise<void> => {
        if (emitted) return;
        emitted = true;
        eventsClient.record(
            buildEventInput(
                meta,
                tags,
                startedAt,
                now(),
                {
                    promptTokens: prompt,
                    completionTokens: completion,
                    // 0 must omit the field (matches the non-stream path); only a
                    // positive cache count is recorded.
                    ...(cache > 0 ? { cacheTokens: cache } : {}),
                    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
                    ...(requestId !== undefined ? { requestId } : {}),
                },
                errored,
            ),
        );
        // Symmetric with the non-stream path: cost must commit before next
        // call's preflight so block budgets stop the next call at the cap.
        await safeFlush(eventsClient);
    };

    const wrapper = {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
            const inner = iterable[Symbol.asyncIterator]();
            return {
                async next(): Promise<IteratorResult<unknown>> {
                    let res: IteratorResult<unknown>;
                    try {
                        res = await inner.next();
                    } catch (err) {
                        await finalize(true);
                        throw err;
                    }
                    if (res.done) {
                        await finalize(false);
                        return res;
                    }
                    if (streamHandler !== undefined) {
                        const delta = streamHandler(res.value);
                        if (delta !== null) {
                            prompt += delta.promptTokensDelta;
                            completion += delta.completionTokensDelta;
                            cache += delta.cacheTokensDelta ?? 0;
                            cacheWrite += delta.cacheWriteTokensDelta ?? 0;
                            if (requestId === undefined && delta.requestId !== undefined) {
                                requestId = delta.requestId;
                            }
                        }
                    }
                    return res;
                },
                async return(value?: unknown): Promise<IteratorResult<unknown>> {
                    await finalize(false);
                    if (typeof inner.return === "function") return inner.return(value);
                    return { done: true, value };
                },
                async throw(err?: unknown): Promise<IteratorResult<unknown>> {
                    await finalize(true);
                    if (typeof inner.throw === "function") return inner.throw(err);
                    throw err;
                },
            };
        },
    } satisfies AsyncIterable<unknown>;
    // `Response` is a generic provider type the caller asserts. After the
    // type guard above we know `source` is async-iterable, and `wrapper`
    // structurally matches that iterable contract (validated by `satisfies`).
    return wrapper as Response;
}
