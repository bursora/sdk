/**
 * Vercel AI SDK integration.
 *
 * Indie / Next.js apps call `generateText({ model: openai("gpt-4o") })` — they
 * never `new OpenAI()`, so the client-Proxy `wrap()` never sees their calls.
 * The AI SDK's `wrap*Model({ model, middleware })` hooks are the one place that
 * can both gate a call before it goes out and read its usage after, so Bursora
 * plugs in there — one middleware per model kind the SDK lets you wrap:
 *
 *   - `bursoraMiddleware` → `wrapLanguageModel` — `generateText`, `streamText`,
 *     `generateObject`, `streamObject`, tool loops, agents (all run on a
 *     language model).
 *   - `bursoraEmbeddingMiddleware` → `wrapEmbeddingModel` — `embed`, `embedMany`.
 *   - `bursoraImageMiddleware` → `wrapImageModel` — `generateImage`.
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
 * Every hook gates first (a block-mode denial throws before the provider call)
 * then records the call's usage. `wrapGenerate`/`wrapEmbed` are single-shot:
 * gate, run, map usage, record. `wrapStream` gates the same way, then taps the
 * returned stream and records on the `finish` part once it ends.
 *
 * Each model call is metered, including every step of a multi-step tool loop —
 * the middleware fires once per step, so the recorded sum equals
 * `generateText`'s `totalUsage`.
 *
 * The AI SDK has no middleware slot for transcription, speech, video, or
 * reranking models, so `transcribe`/`generateSpeech`/`generateVideo`/`rerank`
 * cannot be metered through this integration.
 *
 * `ai` is an optional peer dependency. This module never imports it; the
 * returned objects are structurally the SDK's middleware types. The language
 * middleware satisfies both `LanguageModelV2Middleware` (AI SDK 5) and
 * `LanguageModelV3Middleware` (AI SDK 6); embedding and image middleware are AI
 * SDK 6 (`EmbeddingModelV3Middleware` / `ImageModelV3Middleware`). Across both
 * versions the hook shape is identical; only token usage differs — flat numbers
 * on V2, nested `inputTokens.{total,cacheRead,...}` on V3 — and `mapUsage` reads
 * either, so the same value drops into either version's `wrapLanguageModel`.
 */

import { type BursoraOptions, createBursora } from "../bursora";
import { buildEventInput, preflightGate, type RecordTarget } from "../internal/lifecycle";
import { currentTags } from "../tags";
import type { Tags, UsageTotals } from "../types";
import type { BursoraCore } from "../wrap";

/** The slice of any AI SDK model the middleware reads for the call intent. */
interface ModelLike {
    readonly provider: string;
    readonly modelId: string;
}

/**
 * Token usage as the AI SDK reports it on a generate result. Two shapes ship:
 * AI SDK 5 (`LanguageModelV2Usage`) is flat; AI SDK 6 (`LanguageModelV3Usage`)
 * nests input/output. This union is a supertype of both, so either version's
 * result stays assignable; `mapUsage` reads whichever arrived. Leaves are
 * `number | undefined` per the spec and read defensively.
 */
type LanguageModelUsageLike =
    | {
          readonly inputTokens?: number | undefined;
          readonly outputTokens?: number | undefined;
          readonly totalTokens?: number | undefined;
          readonly reasoningTokens?: number | undefined;
          readonly cachedInputTokens?: number | undefined;
      }
    | {
          readonly inputTokens?: {
              readonly total?: number | undefined;
              readonly noCache?: number | undefined;
              readonly cacheRead?: number | undefined;
              readonly cacheWrite?: number | undefined;
          };
          readonly outputTokens?: {
              readonly total?: number | undefined;
              readonly text?: number | undefined;
              readonly reasoning?: number | undefined;
          };
      };

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
 * The slice of an embed result the middleware reads. Embeddings report input
 * tokens only (`EmbeddingModelV3Result.usage = { tokens }`); there is no
 * completion side and no per-result id at this layer.
 */
interface EmbedResultLike {
    readonly usage?: { readonly tokens?: number };
}

/**
 * The slice of an image-generate result the middleware reads. Token usage is
 * optional — GPT-class models (gpt-image-1) report `{ inputTokens, outputTokens }`;
 * per-image models (DALL-E) report nothing and fall through to 0 tokens, the
 * same intended degrade as the client-Proxy `wrap()` path.
 */
interface ImageResultLike {
    readonly usage?: {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
    };
}

/**
 * The slice of a model call's options the middleware reads. Per-call tags ride
 * on `providerOptions.bursora`; values are untyped JSON, read defensively. The
 * shape is shared by language, embedding, and image call options.
 */
interface CallParamsLike {
    readonly providerOptions?: Record<string, Record<string, unknown>>;
}

interface WrapGenerateOptions<R extends GenerateResultLike> {
    readonly doGenerate: () => PromiseLike<R>;
    readonly model: ModelLike;
    readonly params?: CallParamsLike;
}

interface WrapStreamOptions<S extends StreamResultLike> {
    readonly doStream: () => PromiseLike<S>;
    readonly model: ModelLike;
    readonly params?: CallParamsLike;
}

interface WrapEmbedOptions<R extends EmbedResultLike> {
    readonly doEmbed: () => PromiseLike<R>;
    readonly model: ModelLike;
    readonly params?: CallParamsLike;
}

interface WrapImageOptions<R extends ImageResultLike> {
    readonly doGenerate: () => PromiseLike<R>;
    readonly model: ModelLike;
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
    /**
     * AI SDK 6 (`LanguageModelV3Middleware`) requires this discriminator; AI SDK
     * 5 (`LanguageModelV2Middleware`) has no such field and ignores the extra.
     * It is type-only plumbing — only the hooks below run at runtime.
     */
    readonly specificationVersion: "v3";
    wrapGenerate<R extends GenerateResultLike>(options: WrapGenerateOptions<R>): Promise<R>;
    wrapStream<S extends StreamResultLike>(options: WrapStreamOptions<S>): Promise<S>;
}

/**
 * Bursora's embedding-model middleware (`EmbeddingModelV3Middleware`, AI SDK 6).
 * `wrapEmbed` returns exactly what the wrapped `doEmbed` returns, so the value
 * drops into `wrapEmbeddingModel` unchanged.
 *
 * @public
 */
export interface BursoraEmbeddingModelMiddleware {
    readonly specificationVersion: "v3";
    wrapEmbed<R extends EmbedResultLike>(options: WrapEmbedOptions<R>): Promise<R>;
}

/**
 * Bursora's image-model middleware (`ImageModelV3Middleware`, AI SDK 6).
 * `wrapGenerate` returns exactly what the wrapped image `doGenerate` returns, so
 * the value drops into `wrapImageModel` unchanged.
 *
 * @public
 */
export interface BursoraImageModelMiddleware {
    readonly specificationVersion: "v3";
    wrapGenerate<R extends ImageResultLike>(options: WrapImageOptions<R>): Promise<R>;
}

/**
 * Options for the middleware factories. Pass `apiKey` + `endpoint` to build a
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
 * lifecycle the client-Proxy `wrap()` uses. Covers `generateText`,
 * `streamText`, `generateObject`, `streamObject`, tool loops, and agents.
 *
 * @public
 */
export function bursoraMiddleware(opts: BursoraMiddlewareOptions): BursoraLanguageModelMiddleware {
    const core = opts.core ?? createBursora(opts);
    const closureTags = opts.tags ?? {};

    return {
        specificationVersion: "v3",
        async wrapGenerate<R extends GenerateResultLike>(
            options: WrapGenerateOptions<R>,
        ): Promise<R> {
            const { target, tags } = await gate(core, closureTags, options.model, options.params);
            return meterSingleShot(core, target, tags, options.doGenerate, (result) =>
                mapUsage(result.usage, result.response?.id),
            );
        },

        async wrapStream<S extends StreamResultLike>(options: WrapStreamOptions<S>): Promise<S> {
            const { target, tags } = await gate(core, closureTags, options.model, options.params);

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

/**
 * Build a Bursora middleware for `wrapEmbeddingModel` (AI SDK 6). Gates and
 * meters `embed` / `embedMany`. Embeddings bill on input tokens only.
 *
 * @public
 */
export function bursoraEmbeddingMiddleware(
    opts: BursoraMiddlewareOptions,
): BursoraEmbeddingModelMiddleware {
    const core = opts.core ?? createBursora(opts);
    const closureTags = opts.tags ?? {};

    return {
        specificationVersion: "v3",
        async wrapEmbed<R extends EmbedResultLike>(options: WrapEmbedOptions<R>): Promise<R> {
            const { target, tags } = await gate(core, closureTags, options.model, options.params);
            return meterSingleShot(core, target, tags, options.doEmbed, (result) =>
                mapEmbedUsage(result.usage),
            );
        },
    };
}

/**
 * Build a Bursora middleware for `wrapImageModel` (AI SDK 6). Gates and meters
 * `generateImage`. GPT-class image models report token usage; per-image models
 * record 0 tokens (they still gate and record).
 *
 * @public
 */
export function bursoraImageMiddleware(
    opts: BursoraMiddlewareOptions,
): BursoraImageModelMiddleware {
    const core = opts.core ?? createBursora(opts);
    const closureTags = opts.tags ?? {};

    return {
        specificationVersion: "v3",
        async wrapGenerate<R extends ImageResultLike>(options: WrapImageOptions<R>): Promise<R> {
            const { target, tags } = await gate(core, closureTags, options.model, options.params);
            return meterSingleShot(core, target, tags, options.doGenerate, (result) =>
                mapImageUsage(result.usage),
            );
        },
    };
}

/**
 * Pre-call gate shared by every hook: resolve the effective tags, build the
 * record target from the model, and run the budget gate (a block-mode denial
 * throws here, before the provider call). Returns the resolved pair the caller
 * stamps onto the usage event.
 */
async function gate(
    core: BursoraCore,
    closureTags: Tags,
    model: ModelLike,
    params: CallParamsLike | undefined,
): Promise<{ readonly target: RecordTarget; readonly tags: Tags }> {
    const tags = resolveTags(closureTags, params);
    const target = toTarget(model);
    await preflightGate(core.decision, tags, target);
    return { target, tags };
}

/**
 * Run a single-shot provider call (generate / embed / image), then record one
 * usage event. On a thrown provider error, record an errored event and rethrow.
 * `toUsage` maps the provider's result to Bursora totals; the lifecycle around
 * it is identical for every single-shot hook.
 */
async function meterSingleShot<R>(
    core: BursoraCore,
    target: RecordTarget,
    tags: Tags,
    run: () => PromiseLike<R>,
    toUsage: (result: R) => UsageTotals,
): Promise<R> {
    const startedAt = core.now();
    let result: R;
    try {
        result = await run();
    } catch (err) {
        recordErrored(core, target, tags, startedAt);
        await core.flush();
        throw err;
    }
    core.events.record(
        buildEventInput(target, tags, startedAt, core.now(), toUsage(result), false),
    );
    await core.flush();
    return result;
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
            // One pass over the chunk: a stream part is either a
            // `response-metadata` (carries the request id) or a `finish`
            // (carries final usage), never both, so an else-if is exact.
            if (typeof res.value === "object" && res.value !== null) {
                const c = res.value as { type?: unknown; id?: unknown; usage?: unknown };
                if (c.type === "response-metadata") {
                    if (requestId === undefined && typeof c.id === "string") requestId = c.id;
                } else if (c.type === "finish" && typeof c.usage === "object" && c.usage !== null) {
                    usageRaw = c.usage;
                }
            }
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

function toTarget(model: ModelLike): RecordTarget {
    return { provider: providerSlug(model.provider), model: model.modelId };
}

/**
 * Reduce an AI SDK provider id to a Bursora slug. The SDK reports ids like
 * `"openai.chat"`, `"anthropic.messages"`, `"google.generative-ai"`; Bursora
 * meters on the vendor segment before the first dot (`openai`, `anthropic`,
 * `google`, ...), matching the slugs synced pricing is keyed by.
 */
function providerSlug(provider: string): string {
    return provider.split(".")[0] || provider;
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
 * Map AI SDK language usage to Bursora totals, reading both shapes the SDK ships:
 * AI SDK 5 (V2) reports flat `inputTokens`/`outputTokens`/`cachedInputTokens`
 * numbers; AI SDK 6 (V3) nests them (`inputTokens.{total,cacheRead,cacheWrite}`,
 * `outputTokens.total`). All fields read defensively (external data). The cache
 * slices are billed apart from fresh prompt, so they are split out of
 * `promptTokens` into `cacheTokens`. For V3, `inputTokens.total` folds in both
 * `cacheRead` and `cacheWrite` (Anthropic cache_read + cache_creation), so both
 * are summed into `cacheTokens` (matching the native Anthropic wrap), and the
 * write slice is also reported on its own as `cacheWriteTokens` so the server
 * prices writes (above base input) apart from reads (below it). Output maps
 * straight to `completionTokens` (it already includes reasoning tokens).
 */
function mapUsage(usageRaw: unknown, requestId: string | undefined): UsageTotals {
    const u = asRecord(usageRaw) ?? {};
    const nestedInput = asRecord(u.inputTokens);
    const totalPrompt =
        (nestedInput ? numField(nestedInput, "total") : numField(u, "inputTokens")) ?? 0;
    let cache: number | undefined;
    let cacheWrite: number | undefined;
    if (nestedInput) {
        const read = numField(nestedInput, "cacheRead");
        const write = numField(nestedInput, "cacheWrite");
        cache = read === undefined && write === undefined ? undefined : (read ?? 0) + (write ?? 0);
        cacheWrite = write;
    } else {
        // V2 reports only the cache-read slice (`cachedInputTokens`); no writes.
        cache = numField(u, "cachedInputTokens");
    }
    const completion =
        (nestedInput
            ? numField(asRecord(u.outputTokens) ?? {}, "total")
            : numField(u, "outputTokens")) ?? 0;
    return {
        promptTokens: Math.max(0, totalPrompt - (cache ?? 0)),
        completionTokens: completion,
        ...(cache === undefined ? {} : { cacheTokens: cache }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
        ...(requestId === undefined ? {} : { requestId }),
    };
}

/**
 * Map embedding usage to Bursora totals. Embeddings report input tokens only
 * (`usage.tokens`); there is no completion side, so it is always 0.
 */
function mapEmbedUsage(usage: EmbedResultLike["usage"]): UsageTotals {
    return { promptTokens: usage?.tokens ?? 0, completionTokens: 0 };
}

/**
 * Map image usage to Bursora totals. GPT-class image models report
 * `{ inputTokens, outputTokens }`; per-image models report nothing, so both
 * fall through to 0 (the call still gates and records).
 */
function mapImageUsage(usage: ImageResultLike["usage"]): UsageTotals {
    return {
        promptTokens: usage?.inputTokens ?? 0,
        completionTokens: usage?.outputTokens ?? 0,
    };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function numField(obj: Record<string, unknown>, key: string): number | undefined {
    const v = obj[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
