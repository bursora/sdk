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

import { BudgetExceededError } from "../errors";
import { currentTags } from "../tags";
import type { Decision, Tags, UsageDelta, UsageTotals } from "../types";
import type { CallIntent } from "./decision";
import { type EventsClient, safeFlush } from "./events";

interface CallMeta {
    readonly provider: string;
    readonly model: string;
    readonly isStream: boolean;
}

export interface DecisionLookup {
    fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null>;
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

        const decision = await opts.decisionClient.fetchDecision(tags, {
            provider: meta.provider,
            model: meta.model,
        });
        if (decision !== null && !decision.allow && decision.mode === "block") {
            throw new BudgetExceededError({
                tag: tags,
                reason: decision.reason,
                mode: decision.mode,
            });
        }

        const startedAt = opts.now();
        let response: Response;
        try {
            response = await call(args);
        } catch (err) {
            emitErrored(meta, tags, opts.eventsClient, opts.now, startedAt);
            await safeFlush(opts.eventsClient);
            throw err;
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
        opts.eventsClient.record({
            ...baseEvent(meta, tags, startedAt, opts.now()),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            ...(usage.cacheTokens === undefined ? {} : { cacheTokens: usage.cacheTokens }),
            ...(usage.requestId === undefined ? {} : { requestId: usage.requestId }),
        });
        // Await: cost must commit before next preflight so block budgets stop
        // the next call once cumulative spend crosses the cap.
        await safeFlush(opts.eventsClient);
        return response;
    };
}

function baseEvent(meta: CallMeta, tags: Tags, startedAt: number, finishedAt: number) {
    return {
        provider: meta.provider,
        model: meta.model,
        ts: new Date(startedAt).toISOString(),
        tenantId: tags.tenant_id ?? null,
        agentId: tags.agent_id ?? null,
        workflowId: tags.workflow_id ?? null,
        latencyMs: finishedAt - startedAt,
    };
}

function emitErrored(
    meta: CallMeta,
    tags: Tags,
    eventsClient: EventsClient,
    now: () => number,
    startedAt: number,
): void {
    eventsClient.record({
        ...baseEvent(meta, tags, startedAt, now()),
        promptTokens: 0,
        completionTokens: 0,
        errored: true,
    });
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
    const iterable = source as unknown as AsyncIterable<unknown>;
    let prompt = 0;
    let completion = 0;
    let cache = 0;
    let requestId: string | undefined;
    let emitted = false;

    const finalize = async (errored: boolean): Promise<void> => {
        if (emitted) return;
        emitted = true;
        eventsClient.record({
            ...baseEvent(meta, tags, startedAt, now()),
            promptTokens: prompt,
            completionTokens: completion,
            ...(cache > 0 ? { cacheTokens: cache } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
            ...(errored ? { errored: true } : {}),
        });
        // Symmetric with the non-stream path: cost must commit before next
        // call's preflight so block budgets stop the next call at the cap.
        await safeFlush(eventsClient);
    };

    const wrapper: AsyncIterable<unknown> = {
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
    };
    return wrapper as unknown as Response;
}
