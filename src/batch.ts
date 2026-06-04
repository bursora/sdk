/**
 * Batch-API metering.
 *
 * Batch jobs (OpenAI `batches`, Anthropic Message Batches) bill 50% off the
 * synchronous rate but report usage only when results are fetched
 * asynchronously — minutes to 24h after submit. There is no single
 * request/response seam at submit, so these calls can't be pre-gated the way
 * `wrap()` gates synchronous calls: submit is fail-open (the job goes out
 * unmetered and ungated), and spend is captured here, at results-fetch.
 *
 * Each helper reads the per-result model + usage, records one `batch: true`
 * usage event per succeeded result, then flushes. The server prices `batch`
 * events at 0.5x. Use the shared-core form of `wrap()` (see `createBursora`) so
 * the same `BursoraCore` — and its events queue — backs both the wrapped client
 * and these helpers.
 *
 *   const core = createBursora({ apiKey, endpoint });
 *   const anthropic = wrap(new Anthropic(), core);
 *   // ...after the batch ends:
 *   const results = await anthropic.messages.batches.results(batchId);
 *   await meterAnthropicBatch(core, results);
 */

import { messagesUsage } from "./providers/anthropic";
import type { Tags, UsageTotals } from "./types";
import type { BursoraCore } from "./wrap";

export interface BatchMeterOptions {
    /** Tags stamped onto every event recorded from this batch. */
    readonly tags?: Tags;
}

interface BatchEntry {
    readonly model: string;
    readonly usage: UsageTotals;
}

/**
 * Records one `batch: true` event per entry, then flushes. Batch events are
 * never pre-gated, so there is no decision lookup — just record and drain.
 */
function recordBatchEntries(
    core: BursoraCore,
    provider: string,
    entries: readonly BatchEntry[],
    opts: BatchMeterOptions | undefined,
): Promise<void> {
    const ts = new Date(core.now()).toISOString();
    const tags = opts?.tags;
    for (const entry of entries) {
        core.events.record({
            provider,
            model: entry.model,
            promptTokens: entry.usage.promptTokens,
            completionTokens: entry.usage.completionTokens,
            ...(entry.usage.cacheTokens === undefined
                ? {}
                : { cacheTokens: entry.usage.cacheTokens }),
            ...(entry.usage.cacheWriteTokens === undefined
                ? {}
                : { cacheWriteTokens: entry.usage.cacheWriteTokens }),
            ...(entry.usage.requestId === undefined ? {} : { requestId: entry.usage.requestId }),
            batch: true,
            ts,
            tenantId: tags?.tenant_id ?? null,
            agentId: tags?.agent_id ?? null,
            workflowId: tags?.workflow_id ?? null,
        });
    }
    return core.flush();
}

// Minimal structural view of one line from `messages.batches.results()`. Only
// the `succeeded` branch carries a message with usage; errored / canceled /
// expired entries are skipped (no tokens, no cost). The shape matches what
// `messagesUsage` reads, so the sync extractor is reused verbatim.
interface AnthropicBatchUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
}
interface AnthropicBatchMessage {
    readonly id?: string;
    readonly model?: string;
    readonly usage?: AnthropicBatchUsage;
}
interface AnthropicBatchResponse {
    readonly result?: {
        readonly type?: string;
        readonly message?: AnthropicBatchMessage;
    };
}

/**
 * Meters an Anthropic Message Batch. Pass the async iterable returned by
 * `messages.batches.results(batchId)` (or the `beta` mirror). Each succeeded
 * result records one event tagged `anthropic` with `batch: true`.
 */
export async function meterAnthropicBatch(
    core: BursoraCore,
    results: AsyncIterable<AnthropicBatchResponse>,
    opts?: BatchMeterOptions,
): Promise<void> {
    const entries: BatchEntry[] = [];
    for await (const item of results) {
        const result = item.result;
        if (result?.type !== "succeeded" || result.message === undefined) continue;
        const message = result.message;
        // Model is always present on a succeeded message; skip rather than emit
        // an empty model, which the events endpoint rejects (model min length 1).
        if (typeof message.model !== "string" || message.model === "") continue;
        entries.push({ model: message.model, usage: messagesUsage(message) });
    }
    await recordBatchEntries(core, "anthropic", entries, opts);
}

// One line of an OpenAI batch output file. `response.body` is the same shape
// the sync endpoint returns: a chat completion / embedding (`prompt_tokens` +
// `completion_tokens`) or a response (`input_tokens` + `output_tokens`).
interface OpenAIBatchUsage {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly input_tokens_details?: { readonly cached_tokens?: number };
}
interface OpenAIBatchOutputLine {
    readonly response?: {
        readonly body?: {
            readonly model?: string;
            readonly usage?: OpenAIBatchUsage;
        };
    };
}

// Mirrors the sync OpenAI extractors: the prompt count excludes cached input,
// which is reported separately as `cacheTokens`. Handles both the chat /
// embeddings shape (`prompt_tokens`) and the responses shape (`input_tokens`).
function openaiBatchUsage(usage: OpenAIBatchUsage | undefined): UsageTotals {
    const cached =
        usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens;
    const totalPrompt = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    return {
        promptTokens: totalPrompt - (cached ?? 0),
        completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
        ...(cached !== undefined ? { cacheTokens: cached } : {}),
    };
}

/**
 * Meters an OpenAI batch. Pass the text of the batch output file — e.g.
 * `await (await openai.files.content(batch.output_file_id)).text()`. Each JSONL
 * line with a `response.body` records one event tagged `openai` with
 * `batch: true`; lines without a successful body (errors) are skipped.
 */
export function meterOpenAIBatch(
    core: BursoraCore,
    outputFileText: string,
    opts?: BatchMeterOptions,
): Promise<void> {
    const entries: BatchEntry[] = [];
    for (const line of outputFileText.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let parsed: OpenAIBatchOutputLine;
        try {
            parsed = JSON.parse(trimmed) as OpenAIBatchOutputLine;
        } catch {
            continue;
        }
        const body = parsed.response?.body;
        if (body === undefined || typeof body.model !== "string") continue;
        entries.push({ model: body.model, usage: openaiBatchUsage(body.usage) });
    }
    return recordBatchEntries(core, "openai", entries, opts);
}
