/**
 * Vercel AI SDK integration.
 *
 * Indie / Next.js apps call `generateText({ model: openai("gpt-4o") })` — they
 * never `new OpenAI()`, so the client-Proxy `wrap()` never sees their calls.
 * The AI SDK's `wrapLanguageModel({ model, middleware })` is the one hook that
 * can both gate a call before it goes out and read its usage after, so Bursora
 * plugs in there:
 *
 *   import { wrapLanguageModel } from "ai";
 *   import { openai } from "@ai-sdk/openai";
 *   import { bursoraMiddleware } from "@bursora/sdk";
 *
 *   const model = wrapLanguageModel({
 *     model: openai("gpt-4o"),
 *     middleware: bursoraMiddleware({ apiKey, endpoint, tags: { tenant_id: "acme" } }),
 *   });
 *
 * `wrapGenerate` runs the budget gate before `doGenerate()` (a block-mode
 * denial throws out of `generateText`, so the model is never called) and
 * records the step's usage after. `wrapStream` gates the same way, then taps
 * the returned stream and records on the `finish` part.
 *
 * Each model call is metered, including every step of a multi-step tool loop —
 * the middleware fires once per step, so the recorded sum equals
 * `generateText`'s `totalUsage`. There is no single per-call `totalUsage` to
 * read at the language-model layer; per-step metering is the equivalent.
 *
 * `ai` is an optional peer dependency. This module never imports it; the
 * returned object is structurally a `LanguageModelV2Middleware` (AI SDK 5) and
 * a `LanguageModelV3Middleware` (AI SDK 6) — the hook contract is identical
 * across both, only the type suffix differs — so the same value drops into
 * either version's `wrapLanguageModel`.
 */

import { type BursoraOptions, createBursora } from "./bursora";
import { buildEventInput, preflightGate, type RecordTarget } from "./internal/lifecycle";
import { currentTags } from "./tags";
import type { Tags, UsageTotals } from "./types";
import type { BursoraCore } from "./wrap";

/**
 * Normalized token usage as the AI SDK reports it on a generate result and on
 * the stream `finish` part. Every field is optional because the spec types
 * them as `number | undefined`; values are read defensively.
 */
interface LanguageModelUsageLike {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
}

/** The slice of a `LanguageModelV2`/`V3` the middleware reads for the call intent. */
interface LanguageModelLike {
    readonly provider: string;
    readonly modelId: string;
}

/** The slice of a generate result the middleware reads. */
interface GenerateResultLike {
    readonly usage: LanguageModelUsageLike;
    readonly response?: { readonly id?: string };
}

/** The slice of a stream result the middleware reads. */
interface StreamResultLike {
    readonly stream: ReadableStream<unknown>;
}

/**
 * The slice of `LanguageModelV2CallOptions` the middleware reads. Per-call tags
 * ride on `providerOptions.bursora`; values are untyped JSON, read defensively.
 */
interface CallParamsLike {
    readonly providerOptions?: Record<string, Record<string, unknown>>;
}

interface WrapGenerateOptions<R extends GenerateResultLike> {
    readonly doGenerate: () => PromiseLike<R>;
    readonly model: LanguageModelLike;
    readonly params?: CallParamsLike;
}

interface WrapStreamOptions<S extends StreamResultLike> {
    readonly doStream: () => PromiseLike<S>;
    readonly model: LanguageModelLike;
    readonly params?: CallParamsLike;
}

/**
 * Bursora's language-model middleware. Generic hooks keep the return value
 * assignable to both `LanguageModelV2Middleware` and `LanguageModelV3Middleware`
 * without importing `ai`: each hook returns exactly what the wrapped
 * `doGenerate`/`doStream` returns.
 *
 * @public
 */
export interface BursoraLanguageModelMiddleware {
    wrapGenerate<R extends GenerateResultLike>(options: WrapGenerateOptions<R>): Promise<R>;
    wrapStream<S extends StreamResultLike>(options: WrapStreamOptions<S>): Promise<S>;
}

/**
 * Options for `bursoraMiddleware`. Pass `apiKey` + `endpoint` to build a
 * private `BursoraCore`, or `core` to share one across many wrapped models.
 * `tags` are threaded into every decision lookup and usage event for this
 * model (see {@link resolveTags} for per-call overrides).
 *
 * @public
 */
export interface BursoraMiddlewareOptions extends BursoraOptions {
    readonly tags?: Tags;
    readonly core?: BursoraCore;
}

/**
 * Build a Bursora middleware for `wrapLanguageModel`. The wrapped model gates
 * every call against the budget and records its usage — same decision + events
 * lifecycle the client-Proxy `wrap()` uses.
 *
 * @public
 */
export function bursoraMiddleware(opts: BursoraMiddlewareOptions): BursoraLanguageModelMiddleware {
    const core = opts.core ?? createBursora(opts);
    const closureTags = opts.tags ?? {};

    return {
        async wrapGenerate<R extends GenerateResultLike>(
            options: WrapGenerateOptions<R>,
        ): Promise<R> {
            const tags = resolveTags(closureTags, options.params);
            const target = toTarget(options.model);
            await preflightGate(core.decision, tags, target);

            const startedAt = core.now();
            let result: R;
            try {
                result = await options.doGenerate();
            } catch (err) {
                recordErrored(core, target, tags, startedAt);
                await core.flush();
                throw err;
            }
            const usage = mapUsage(result.usage, result.response?.id);
            core.events.record(buildEventInput(target, tags, startedAt, core.now(), usage, false));
            await core.flush();
            return result;
        },

        async wrapStream<S extends StreamResultLike>(options: WrapStreamOptions<S>): Promise<S> {
            const tags = resolveTags(closureTags, options.params);
            const target = toTarget(options.model);
            await preflightGate(core.decision, tags, target);

            const startedAt = core.now();
            let result: S;
            try {
                result = await options.doStream();
            } catch (err) {
                recordErrored(core, target, tags, startedAt);
                await core.flush();
                throw err;
            }
            const stream = tapStream(result.stream, core, target, tags, startedAt);
            // `stream` is the only field replaced; every other field of the
            // provider's result passes through untouched, so the object is
            // still a valid `S`.
            return { ...result, stream } as S;
        },
    };
}

function recordErrored(
    core: BursoraCore,
    target: RecordTarget,
    tags: Tags,
    startedAt: number,
): void {
    try {
        core.events.record(buildEventInput(target, tags, startedAt, core.now(), null, true));
    } catch {
        // A buggy record sink must not mask the provider error being rethrown.
    }
}

/**
 * Tap a provider stream: pass every chunk through untouched, capture usage from
 * the `finish` part and the request id from `response-metadata`, then record
 * one usage event when the stream ends (or errors).
 */
function tapStream(
    source: ReadableStream<unknown>,
    core: BursoraCore,
    target: RecordTarget,
    tags: Tags,
    startedAt: number,
): ReadableStream<unknown> {
    const reader = source.getReader();
    type ReadResult = Awaited<ReturnType<typeof reader.read>>;
    let usageRaw: unknown = null;
    let requestId: string | undefined;
    let settled = false;

    const finalize = async (errored: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const usage = errored ? null : mapUsage(usageRaw, requestId);
        try {
            core.events.record(
                buildEventInput(target, tags, startedAt, core.now(), usage, errored),
            );
        } catch {
            // Recording must not poison the stream the consumer is reading.
        }
        await core.flush();
    };

    return new ReadableStream<unknown>({
        async pull(controller): Promise<void> {
            let res: ReadResult;
            try {
                res = await reader.read();
            } catch (err) {
                await finalize(true);
                controller.error(err);
                return;
            }
            if (res.done) {
                await finalize(false);
                controller.close();
                return;
            }
            const id = responseMetadataId(res.value);
            if (id !== undefined && requestId === undefined) requestId = id;
            const finish = finishUsage(res.value);
            if (finish !== null) usageRaw = finish;
            controller.enqueue(res.value);
        },
        cancel(reason): Promise<void> {
            // Consumer abandoned the stream early: record what we have, then
            // release the upstream reader.
            void finalize(false);
            return reader.cancel(reason);
        },
    });
}

function toTarget(model: LanguageModelLike): RecordTarget {
    return { provider: providerSlug(model.provider), model: model.modelId };
}

/**
 * Reduce an AI SDK provider id to a Bursora slug. The SDK reports ids like
 * `"openai.chat"`, `"anthropic.messages"`, `"google.generative-ai"`; Bursora
 * meters on the vendor segment before the first dot (`openai`, `anthropic`,
 * `google`, ...), matching the slugs synced pricing is keyed by.
 */
function providerSlug(provider: string): string {
    const head = provider.split(".")[0];
    return head === undefined || head === "" ? provider : head;
}

/**
 * Merge tags by precedence: closure defaults < `withTags` async context <
 * per-call `providerOptions.bursora`. The most specific source wins.
 */
function resolveTags(closureTags: Tags, params: CallParamsLike | undefined): Tags {
    return { ...closureTags, ...currentTags(), ...tagsFromProviderOptions(params) };
}

function tagsFromProviderOptions(params: CallParamsLike | undefined): Tags {
    const raw = params?.providerOptions?.bursora;
    if (raw === undefined) return {};
    return {
        ...(typeof raw.tenant_id === "string" ? { tenant_id: raw.tenant_id } : {}),
        ...(typeof raw.agent_id === "string" ? { agent_id: raw.agent_id } : {}),
        ...(typeof raw.workflow_id === "string" ? { workflow_id: raw.workflow_id } : {}),
    };
}

/**
 * Map AI SDK usage to Bursora totals. Reads every field defensively (external
 * data). `cachedInputTokens` is the cached slice of the prompt billed cheaper,
 * so it is split out of `promptTokens` exactly like the OpenAI manifest splits
 * `prompt_tokens_details.cached_tokens`. `outputTokens` already includes any
 * reasoning tokens, so it maps straight to `completionTokens`.
 */
function mapUsage(usageRaw: unknown, requestId: string | undefined): UsageTotals {
    const u =
        typeof usageRaw === "object" && usageRaw !== null
            ? (usageRaw as Record<string, unknown>)
            : {};
    const input = numField(u, "inputTokens") ?? 0;
    const cached = numField(u, "cachedInputTokens");
    return {
        promptTokens: Math.max(0, input - (cached ?? 0)),
        completionTokens: numField(u, "outputTokens") ?? 0,
        ...(cached === undefined ? {} : { cacheTokens: cached }),
        ...(requestId === undefined ? {} : { requestId }),
    };
}

function numField(obj: Record<string, unknown>, key: string): number | undefined {
    const v = obj[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finishUsage(chunk: unknown): LanguageModelUsageLike | null {
    if (typeof chunk !== "object" || chunk === null) return null;
    const c = chunk as { type?: unknown; usage?: unknown };
    if (c.type !== "finish") return null;
    if (typeof c.usage !== "object" || c.usage === null) return null;
    return c.usage as LanguageModelUsageLike;
}

function responseMetadataId(chunk: unknown): string | undefined {
    if (typeof chunk !== "object" || chunk === null) return undefined;
    const c = chunk as { type?: unknown; id?: unknown };
    if (c.type !== "response-metadata") return undefined;
    return typeof c.id === "string" ? c.id : undefined;
}
