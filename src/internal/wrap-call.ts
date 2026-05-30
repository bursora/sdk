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
import type { Tags, UsageDelta, UsageTotals } from "../types";
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
                emitErrored(meta, tags, opts.eventsClient, opts.now, startedAt);
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

function emitErrored(
    meta: CallMeta,
    tags: Tags,
    eventsClient: EventsClient,
    now: () => number,
    startedAt: number,
): void {
    eventsClient.record(buildEventInput(meta, tags, startedAt, now(), null, true));
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
