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
 * a `LanguageModelV3Middleware` (AI SDK 6). The hook shape (`doGenerate`,
 * `doStream`, `model`, `params`) is identical across both; only token usage
 * differs — flat numbers on V2, nested `inputTokens.{total,cacheRead,...}` on
 * V3 — and `mapUsage` reads either. So the same value drops into either
 * version's `wrapLanguageModel`.
 */

import { type BursoraOptions, createBursora } from "../bursora";
import { buildEventInput, preflightGate, type RecordTarget } from "../internal/lifecycle";
import { currentTags } from "../tags";
import type { Tags, UsageTotals } from "../types";
import type { BursoraCore } from "../wrap";

/** The slice of a `LanguageModelV2`/`V3` the middleware reads for the call intent. */
interface LanguageModelLike {
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
        specificationVersion: "v3",
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
 * Map AI SDK usage to Bursora totals, reading both shapes the SDK ships: AI SDK
 * 5 (V2) reports flat `inputTokens`/`outputTokens`/`cachedInputTokens` numbers;
 * AI SDK 6 (V3) nests them (`inputTokens.{total,cacheRead,...}`,
 * `outputTokens.total`). All fields read defensively (external data). The
 * cached-read slice is billed cheaper, so it is split out of `promptTokens` into
 * `cacheTokens`, exactly like the OpenAI manifest splits
 * `prompt_tokens_details.cached_tokens`. Output maps straight to
 * `completionTokens` (it already includes reasoning tokens).
 */
function mapUsage(usageRaw: unknown, requestId: string | undefined): UsageTotals {
    const u = asRecord(usageRaw) ?? {};
    const nestedInput = asRecord(u.inputTokens);
    const totalPrompt =
        (nestedInput ? numField(nestedInput, "total") : numField(u, "inputTokens")) ?? 0;
    const cache = nestedInput
        ? numField(nestedInput, "cacheRead")
        : numField(u, "cachedInputTokens");
    const completion =
        (nestedInput
            ? numField(asRecord(u.outputTokens) ?? {}, "total")
            : numField(u, "outputTokens")) ?? 0;
    return {
        promptTokens: Math.max(0, totalPrompt - (cache ?? 0)),
        completionTokens: completion,
        ...(cache === undefined ? {} : { cacheTokens: cache }),
        ...(requestId === undefined ? {} : { requestId }),
    };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function numField(obj: Record<string, unknown>, key: string): number | undefined {
    const v = obj[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
