/**
 * Anthropic provider manifest consumed by the generic `wrap()` engine.
 *
 * Declares the one instrumented method (`messages.create`), how to read
 * model + stream flag from its args, and how to turn its response (or
 * streamed chunks) into usage totals.
 *
 * Anthropic SSE quirks worth knowing:
 *  - `message_start.message.usage.input_tokens` is the prompt count;
 *    output_tokens at that point is always 0.
 *  - `message_delta.usage.output_tokens` is the running CUMULATIVE total,
 *    not an incremental delta. `createAnthropicStreamHandler` closes over
 *    `lastOutputTotal` per stream so the engine's sum-of-deltas matches
 *    the final cumulative figure.
 */

import { structurallyMatches } from "../internal/detect";
import type { MethodSpec, ProviderManifest, UsageDelta, UsageTotals } from "../types";

const PROVIDER = "anthropic";

interface MessagesArgs {
    readonly model: string;
    readonly stream?: boolean;
}

interface AnthropicUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
}

interface MessagesResponse {
    readonly id?: string;
    readonly usage?: AnthropicUsage;
}

interface AnthropicStreamChunk {
    readonly type?: string;
    readonly message?: { readonly id?: string; readonly usage?: AnthropicUsage };
    readonly usage?: AnthropicUsage;
}

export function messagesUsage(response: MessagesResponse): UsageTotals {
    const u = response.usage;
    const cache = (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
    return {
        promptTokens: u?.input_tokens ?? 0,
        completionTokens: u?.output_tokens ?? 0,
        ...(cache > 0 ? { cacheTokens: cache } : {}),
        ...(response.id !== undefined ? { requestId: response.id } : {}),
    };
}

export function createAnthropicStreamHandler(): (chunk: unknown) => UsageDelta | null {
    let lastOutputTotal = 0;
    return (raw: unknown) => {
        const chunk = raw as AnthropicStreamChunk;
        if (chunk.type === "message_start" && chunk.message?.usage !== undefined) {
            const u = chunk.message.usage;
            const cache = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            return {
                promptTokensDelta: u.input_tokens ?? 0,
                completionTokensDelta: u.output_tokens ?? 0,
                cacheTokensDelta: cache,
                ...(chunk.message.id !== undefined ? { requestId: chunk.message.id } : {}),
            };
        }
        if (chunk.type === "message_delta" && chunk.usage !== undefined) {
            const total = chunk.usage.output_tokens ?? 0;
            const delta = total - lastOutputTotal;
            lastOutputTotal = total;
            return {
                promptTokensDelta: 0,
                completionTokensDelta: delta,
                cacheTokensDelta: 0,
            };
        }
        return null;
    };
}

const messagesCreate: MethodSpec<MessagesArgs, MessagesResponse, AnthropicStreamChunk> = {
    path: ["messages", "create"],
    extractMeta: (args) => ({ model: args.model, isStream: args.stream === true }),
    extractUsage: messagesUsage,
    createStreamHandler: createAnthropicStreamHandler,
};

const anthropicMethods: readonly MethodSpec[] = [messagesCreate as MethodSpec];

export const anthropicManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: anthropicMethods,
    detect: structurallyMatches(anthropicMethods),
};
