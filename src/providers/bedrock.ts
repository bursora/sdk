/**
 * Amazon Bedrock integration.
 *
 * Bedrock's call style is unique among the providers Bursora wraps:
 * `client.send(new ConverseCommand|InvokeModelCommand|...({ modelId, ... }))`.
 * One method (`send`), the model lives inside the command object, and usage
 * shapes differ per command and per model family. The structural-detect engine
 * behind `wrap()` can't fit that — folding `send` into a manifest would
 * mis-claim every other AWS v3 client (S3, DynamoDB, ...). So Bedrock gets an
 * explicit adapter, `wrapBedrock(client, optsOrCore)`, parallel to the Vercel
 * AI SDK's `bursoraMiddleware`. It returns a `Wrapped<T>` Proxy over `.send`
 * that gates, runs, and meters each metered command, and exposes `.budget`
 * exactly like `wrap()`.
 *
 * Four command types are metered (everything else passes straight through):
 *  - `ConverseCommand` / `ConverseStreamCommand` — Bedrock normalizes usage
 *    across every family on `usage.{inputTokens,outputTokens}` (+ cache
 *    counts), so these are the recommended, fully-covered path.
 *  - `InvokeModelCommand` / `InvokeModelWithResponseStreamCommand` — the raw
 *    per-family wire shape. Usage is decoded per family (see BEDROCK_FAMILIES).
 *    For streams, every family's terminal chunk carries
 *    `amazon-bedrock-invocationMetrics`, used as the universal backstop when a
 *    family exposes no per-chunk usage (Titan, Mistral, Cohere).
 *
 * Zero hard dependency on `@aws-sdk/*`: every command/response/client type here
 * is structural and read defensively.
 */

import { type BursoraOptions, createBursora } from "../bursora";
import { createBudgetSnapshotTap } from "../internal/budget-snapshot";
import { safeFlush } from "../internal/events";
import { buildEventInput, preflightGate, type RecordTarget } from "../internal/lifecycle";
import { buildProxy } from "../internal/proxy-builder";
import { currentTags } from "../tags";
import type { Tags, UsageDelta, UsageTotals } from "../types";
import type { BursoraCore, Wrapped } from "../wrap";
import { createAnthropicStreamHandler, messagesUsage } from "./anthropic";

const PROVIDER = "bedrock";

/**
 * Per-family decoder for the raw `InvokeModel*` wire shape. Converse normalizes
 * usage itself, so the registry is only consulted on the Invoke path. The
 * family is the segment before the first dot of the model id (after the
 * inference-profile prefix is stripped): `anthropic`, `meta`, `amazon`,
 * `mistral`, `cohere`.
 *
 * @public
 */
export interface BedrockFamily {
    /** Pull usage from a decoded non-stream `InvokeModel` response body. */
    readonly invokeUsage: (body: Record<string, unknown>) => UsageTotals;
    /**
     * Optional per-chunk decoder for an `InvokeModelWithResponseStream` body.
     * Omit when the family emits no usable per-chunk usage — those streams fall
     * back to the `amazon-bedrock-invocationMetrics` backstop on the final chunk.
     */
    readonly createStreamHandler?: () => (chunk: Record<string, unknown>) => UsageDelta | null;
}

/**
 * Usage decoders keyed by model family for the raw `InvokeModel*` path.
 *
 * Anthropic and Amazon Nova report a `usage` object (Nova matches the Converse
 * field names); Meta Llama reports `prompt_token_count`/`generation_token_count`
 * (on the terminal stream chunk only); Amazon Titan reports
 * `inputTextTokenCount` + per-result `tokenCount`. Mistral and Cohere return no
 * token counts on the `InvokeModel` body at all, so their non-stream invoke
 * usage is 0/0 — drive them through `Converse` (normalized usage) or the
 * `InvokeModelWithResponseStream` backstop for real counts.
 *
 * @public
 */
export const BEDROCK_FAMILIES: Readonly<Record<string, BedrockFamily>> = {
    anthropic: {
        // The Bedrock-Anthropic invoke body is the Messages response shape, so
        // the native extractor reads it verbatim (input/output + cache split,
        // matching native Anthropic). Its stream chunks are the same SSE events.
        invokeUsage: (body) => messagesUsage(body as Parameters<typeof messagesUsage>[0]),
        createStreamHandler: createAnthropicStreamHandler,
    },
    meta: {
        invokeUsage: (body) => ({
            promptTokens: num(body.prompt_token_count),
            completionTokens: num(body.generation_token_count),
        }),
        // Llama streams the counts only on the terminal chunk, as totals — one
        // delta equal to the totals is the correct sum.
        createStreamHandler: () => (chunk) => {
            const prompt = num(chunk.prompt_token_count);
            const completion = num(chunk.generation_token_count);
            if (prompt === 0 && completion === 0) return null;
            return { promptTokensDelta: prompt, completionTokensDelta: completion };
        },
    },
    amazon: {
        invokeUsage: (body) => {
            const nova = asRecord(body.usage);
            if (nova !== undefined) return tokenUsage(nova);
            // Titan: input on the body, output summed across result blocks.
            const results = Array.isArray(body.results) ? body.results : [];
            const completion = results.reduce<number>(
                (sum, r) => sum + num(asRecord(r)?.tokenCount),
                0,
            );
            return { promptTokens: num(body.inputTextTokenCount), completionTokens: completion };
        },
        createStreamHandler: () => (chunk) => {
            // Nova carries a usage object on its chunks; Titan does not, so its
            // streams fall through to the invocationMetrics backstop.
            const nova = asRecord(chunk.usage);
            if (nova === undefined) return null;
            const u = tokenUsage(nova);
            return {
                promptTokensDelta: u.promptTokens,
                completionTokensDelta: u.completionTokens,
                cacheTokensDelta: u.cacheTokens ?? 0,
                cacheWriteTokensDelta: u.cacheWriteTokens ?? 0,
            };
        },
    },
    // Mistral and Cohere return no token counts on the InvokeModel body. They
    // gate and record (0/0) on that path; Converse and the stream backstop
    // supply real counts. Registered so the gap is explicit, not a silent
    // unknown-family fallthrough.
    mistral: { invokeUsage: () => ZERO },
    cohere: { invokeUsage: () => ZERO },
};

const ZERO: UsageTotals = { promptTokens: 0, completionTokens: 0 };

/**
 * Wrap an AWS Bedrock Runtime client so every metered command gates against the
 * budget before `send` (a block-mode denial throws `BudgetExceededError`,
 * before the call) and records its usage after. The wrapped client is the same
 * object surface plus a read-only `.budget` headroom snapshot.
 *
 * Pass `{ apiKey, endpoint }` to build a private core, or a pre-built
 * `BursoraCore` to share one decision cache + events queue across clients.
 *
 * @public
 */
export function wrapBedrock<T extends object>(
    client: T,
    optsOrCore: BursoraCore | BursoraOptions,
): Wrapped<T> {
    // `now` is on every BursoraCore and never on BursoraOptions, so its presence
    // distinguishes the two (mirrors `wrap()`).
    const core = "now" in optsOrCore ? optsOrCore : createBursora(optsOrCore);
    const { decision, readBudget } = createBudgetSnapshotTap(core.decision);

    const sendHolder = (client as { send?: unknown }).send;
    if (typeof sendHolder !== "function") {
        throw new Error("[bursora] wrapBedrock: client has no `send` method");
    }
    const send = (sendHolder as (...args: unknown[]) => Promise<unknown>).bind(client);

    const wrappedSend = (command: unknown, ...rest: unknown[]): Promise<unknown> => {
        const meta = metaFor(command);
        // Unknown command, or no model id to price against: pass straight
        // through, untouched and unmetered.
        if (meta === null) return send(command, ...rest);
        return runMetered(meta, () => send(command, ...rest), core, decision);
    };

    return buildProxy(client, {
        leaves: [["send", wrappedSend]],
        lifecycle: { readBudget },
    }) as Wrapped<T>;
}

type CommandKind = "converse" | "converse-stream" | "invoke" | "invoke-stream";

interface CommandMeta {
    readonly kind: CommandKind;
    readonly target: RecordTarget;
    readonly family: string;
}

const COMMAND_KINDS: Readonly<Record<string, CommandKind>> = {
    ConverseCommand: "converse",
    ConverseStreamCommand: "converse-stream",
    InvokeModelCommand: "invoke",
    InvokeModelWithResponseStreamCommand: "invoke-stream",
};

function metaFor(command: unknown): CommandMeta | null {
    if (typeof command !== "object" || command === null) return null;
    const name = (command as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name !== "string") return null;
    const kind = COMMAND_KINDS[name];
    if (kind === undefined) return null;
    const modelId = (command as { input?: { modelId?: unknown } }).input?.modelId;
    if (typeof modelId !== "string" || modelId === "") return null;
    const model = stripInferenceProfile(modelId);
    return { kind, target: { provider: PROVIDER, model }, family: familyOf(model) };
}

/**
 * Drop the cross-region inference-profile prefix (`us.`/`eu.`/`apac.`) so the
 * recorded model matches the synced Bedrock pricing rows, which are keyed by the
 * bare model id. The version suffix (e.g. `-v2:0`) is part of the id and kept.
 * Must stay in step with the backend's bedrock key normalization.
 */
function stripInferenceProfile(modelId: string): string {
    return modelId.replace(/^(?:us|eu|apac)\./, "");
}

function familyOf(model: string): string {
    const dot = model.indexOf(".");
    return dot === -1 ? model : model.slice(0, dot);
}

async function runMetered(
    meta: CommandMeta,
    call: () => Promise<unknown>,
    core: BursoraCore,
    decision: ReturnType<typeof createBudgetSnapshotTap>["decision"],
): Promise<unknown> {
    const tags = currentTags();
    await preflightGate(decision, tags, meta.target);

    const startedAt = core.now();
    let response: unknown;
    try {
        response = await call();
    } catch (err) {
        recordErrored(core, meta.target, tags, startedAt);
        await safeFlush(core.events);
        throw err;
    }

    if (meta.kind === "converse-stream" || meta.kind === "invoke-stream") {
        return tapStream(meta, response, core, tags, startedAt);
    }

    const usage =
        meta.kind === "converse"
            ? converseUsage(asRecord((response as { usage?: unknown }).usage))
            : invokeUsage(meta.family, (response as { body?: unknown }).body);
    core.events.record(buildEventInput(meta.target, tags, startedAt, core.now(), usage, false));
    await safeFlush(core.events);
    return response;
}

/**
 * Replace the response's stream with a pass-through that decodes usage as it
 * flows, then record one event when the stream ends (or errors). The consumer
 * reads the exact same chunks; nothing is buffered or dropped.
 */
function tapStream(
    meta: CommandMeta,
    response: unknown,
    core: BursoraCore,
    tags: Tags,
    startedAt: number,
): unknown {
    const isConverse = meta.kind === "converse-stream";
    const field = isConverse ? "stream" : "body";
    const source = (response as Record<string, unknown>)[field];
    if (!isAsyncIterable(source)) return response;

    const acc: Mutable = {
        prompt: 0,
        completion: 0,
        cache: 0,
        cacheWrite: 0,
        requestId: undefined,
    };
    let metricsPrompt = 0;
    let metricsCompletion = 0;
    const handler = isConverse ? undefined : BEDROCK_FAMILIES[meta.family]?.createStreamHandler?.();
    let settled = false;

    const finalize = async (errored: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const usage = errored ? null : streamUsage(acc, metricsPrompt, metricsCompletion);
        try {
            core.events.record(
                buildEventInput(meta.target, tags, startedAt, core.now(), usage, errored),
            );
        } catch {
            // Recording must not poison the stream the consumer is reading.
        }
        await safeFlush(core.events);
    };

    const onChunk = (raw: unknown): void => {
        const decoded = isConverse ? asRecord(raw) : decodeChunk(raw);
        if (decoded === undefined) return;
        if (isConverse) {
            const usage = asRecord(asRecord(decoded.metadata)?.usage);
            if (usage !== undefined) applyConverse(acc, usage);
            return;
        }
        const metrics = asRecord(decoded["amazon-bedrock-invocationMetrics"]);
        if (metrics !== undefined) {
            metricsPrompt = num(metrics.inputTokenCount);
            metricsCompletion = num(metrics.outputTokenCount);
        }
        if (handler === undefined) return;
        let delta: UsageDelta | null;
        try {
            delta = handler(decoded);
        } catch {
            // A throwing family handler must never poison the user's stream.
            return;
        }
        if (delta !== null) applyDelta(acc, delta);
    };

    const wrapped = wrapAsyncIterable(source, onChunk, finalize);
    return { ...(response as object), [field]: wrapped };
}

interface Mutable {
    prompt: number;
    completion: number;
    cache: number;
    cacheWrite: number;
    requestId: string | undefined;
}

function applyDelta(acc: Mutable, delta: UsageDelta): void {
    acc.prompt += delta.promptTokensDelta;
    acc.completion += delta.completionTokensDelta;
    acc.cache += delta.cacheTokensDelta ?? 0;
    acc.cacheWrite += delta.cacheWriteTokensDelta ?? 0;
    if (acc.requestId === undefined && delta.requestId !== undefined)
        acc.requestId = delta.requestId;
}

function applyConverse(acc: Mutable, usage: Record<string, unknown>): void {
    const u = converseUsage(usage);
    acc.prompt = u.promptTokens;
    acc.completion = u.completionTokens;
    acc.cache = u.cacheTokens ?? 0;
    acc.cacheWrite = u.cacheWriteTokens ?? 0;
}

// Family decode wins when it produced counts; otherwise the universal
// invocationMetrics backstop (present on the terminal chunk of every Invoke
// stream) supplies prompt/completion.
function streamUsage(acc: Mutable, metricsPrompt: number, metricsCompletion: number): UsageTotals {
    const useMetrics = acc.prompt === 0 && acc.completion === 0;
    const prompt = useMetrics ? metricsPrompt : acc.prompt;
    const completion = useMetrics ? metricsCompletion : acc.completion;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        ...(acc.cache > 0 ? { cacheTokens: acc.cache } : {}),
        ...(acc.cacheWrite > 0 ? { cacheWriteTokens: acc.cacheWrite } : {}),
        ...(acc.requestId !== undefined ? { requestId: acc.requestId } : {}),
    };
}

function invokeUsage(family: string, body: unknown): UsageTotals {
    const decoded = decodeChunk(body);
    const fam = BEDROCK_FAMILIES[family];
    if (decoded === undefined || fam === undefined) return ZERO;
    return fam.invokeUsage(decoded);
}

/**
 * Map a Bedrock `TokenUsage` (Converse, and the Nova invoke body) to Bursora
 * totals. `inputTokens` already excludes cache (matching native Anthropic
 * `input_tokens`); cache read + write are summed into `cacheTokens`, and the
 * write slice is reported on its own so the server prices writes above base
 * input and reads below it. Both Converse (`...InputTokens`) and the alternate
 * `...InputTokenCount` spelling are read defensively.
 */
function converseUsage(usage: Record<string, unknown> | undefined): UsageTotals {
    return usage === undefined ? ZERO : tokenUsage(usage);
}

function tokenUsage(u: Record<string, unknown>): UsageTotals {
    const cacheRead = num(u.cacheReadInputTokens ?? u.cacheReadInputTokenCount);
    const cacheWrite = num(u.cacheWriteInputTokens ?? u.cacheWriteInputTokenCount);
    const cache = cacheRead + cacheWrite;
    return {
        promptTokens: num(u.inputTokens),
        completionTokens: num(u.outputTokens),
        ...(cache > 0 ? { cacheTokens: cache } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
}

// Bedrock invoke-stream items are `{ chunk: { bytes: Uint8Array } }`; the
// non-stream invoke body is a bare `Uint8Array`. Decode either to JSON.
function decodeChunk(raw: unknown): Record<string, unknown> | undefined {
    const bytes =
        typeof raw === "object" && raw !== null && "chunk" in raw
            ? asRecord((raw as { chunk?: unknown }).chunk)?.bytes
            : raw;
    if (bytes === undefined || bytes === null) return undefined;
    try {
        const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes as never);
        const parsed: unknown = JSON.parse(text);
        return asRecord(parsed);
    } catch {
        return undefined;
    }
}

/**
 * Pass-through async-iterable wrapper: yields every item of `source` untouched,
 * feeds each to `onChunk`, and calls `finalize` exactly once when iteration
 * ends, the consumer breaks early (`return`), or it throws.
 */
function wrapAsyncIterable(
    source: AsyncIterable<unknown>,
    onChunk: (raw: unknown) => void,
    finalize: (errored: boolean) => Promise<void>,
): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
            const inner = source[Symbol.asyncIterator]();
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
                    onChunk(res.value);
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

function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
    return (
        typeof x === "object" &&
        x !== null &&
        typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
    );
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
