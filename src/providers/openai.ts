/**
 * OpenAI provider manifest.
 *
 * Declares the four OpenAI client methods Bursora instruments
 * (`chat.completions.create`, `responses.create`, `embeddings.create`,
 * `beta.chat.completions.parse`) plus per-method usage extractors. The
 * generic `wrap()` engine reads this manifest to assemble the Proxy.
 */

import { structurallyMatches } from "../internal/detect";
import type { MethodSpec, ProviderManifest, UsageDelta, UsageTotals } from "../types";

interface ChatArgs {
    readonly model: string;
    readonly stream?: boolean;
}
interface ChatResponse {
    readonly id?: string;
    readonly usage?: {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly prompt_tokens_details?: {
            readonly cached_tokens?: number;
        };
    };
}

interface ResponsesArgs {
    readonly model: string;
    readonly stream?: boolean;
}
interface ResponsesResponse {
    readonly id?: string;
    readonly usage?: {
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly input_tokens_details?: {
            readonly cached_tokens?: number;
        };
    };
}

interface EmbeddingsArgs {
    readonly model: string;
}
interface EmbeddingsResponse {
    readonly id?: string;
    readonly usage?: {
        readonly prompt_tokens: number;
        readonly total_tokens?: number;
    };
}

interface OpenAIStreamChunk {
    readonly id?: string;
    readonly usage?: {
        readonly prompt_tokens?: number;
        readonly completion_tokens?: number;
        readonly prompt_tokens_details?: {
            readonly cached_tokens?: number;
        };
    };
}

type ManifestUsage = UsageTotals;

function chatUsage(response: ChatResponse): ManifestUsage {
    const u = response.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens;
    const totalPrompt = u?.prompt_tokens ?? 0;
    return {
        promptTokens: totalPrompt - (cached ?? 0),
        completionTokens: u?.completion_tokens ?? 0,
        ...(cached !== undefined ? { cacheTokens: cached } : {}),
        ...(response.id !== undefined ? { requestId: response.id } : {}),
    };
}

function responsesUsage(response: ResponsesResponse): ManifestUsage {
    const u = response.usage;
    const cached = u?.input_tokens_details?.cached_tokens;
    const totalInput = u?.input_tokens ?? 0;
    return {
        promptTokens: totalInput - (cached ?? 0),
        completionTokens: u?.output_tokens ?? 0,
        ...(cached !== undefined ? { cacheTokens: cached } : {}),
        ...(response.id !== undefined ? { requestId: response.id } : {}),
    };
}

function embeddingsUsage(response: EmbeddingsResponse): ManifestUsage {
    const u = response.usage;
    return {
        promptTokens: u?.prompt_tokens ?? 0,
        completionTokens: 0,
        ...(response.id !== undefined ? { requestId: response.id } : {}),
    };
}

// OpenAI typically reports `usage` once on a terminal stream chunk, but a
// chunk can legitimately carry `cached_tokens` without `prompt_tokens`. The
// handler tracks the latest seen totals across the stream and emits deltas
// relative to the previously emitted totals so the engine's sum-of-deltas
// matches the final correct values. Subtracting cache per chunk (instead of
// at stream end) would underflow promptTokens when a cache-only chunk arrives
// before any prompt_tokens chunk.
export function createOpenAIStreamHandler(): (chunk: unknown) => UsageDelta | null {
    let promptTotal = 0;
    let completionTotal = 0;
    let cacheTotal = 0;
    let lastEmittedPromptUncached = 0;
    let lastEmittedCompletion = 0;
    let lastEmittedCache = 0;
    let requestId: string | undefined;

    return (raw: unknown) => {
        const chunk = raw as OpenAIStreamChunk;
        if (requestId === undefined && chunk.id !== undefined) requestId = chunk.id;
        const u = chunk.usage;
        if (!u && chunk.id === undefined) return null;

        if (u?.prompt_tokens !== undefined) promptTotal = u.prompt_tokens;
        if (u?.completion_tokens !== undefined) completionTotal = u.completion_tokens;
        if (u?.prompt_tokens_details?.cached_tokens !== undefined) {
            cacheTotal = u.prompt_tokens_details.cached_tokens;
        }

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

const chatMeta = (args: unknown) => {
    const a = args as ChatArgs;
    return { model: a.model, isStream: a.stream === true };
};

const chatCompletionsCreate: MethodSpec<ChatArgs, ChatResponse, OpenAIStreamChunk> = {
    path: ["chat", "completions", "create"],
    extractMeta: chatMeta,
    extractUsage: (res) => chatUsage(res as ChatResponse),
    createStreamHandler: createOpenAIStreamHandler,
};

const responsesCreate: MethodSpec<ResponsesArgs, ResponsesResponse, OpenAIStreamChunk> = {
    path: ["responses", "create"],
    optional: true,
    extractMeta: (args) => {
        const a = args as ResponsesArgs;
        return { model: a.model, isStream: a.stream === true };
    },
    extractUsage: (res) => responsesUsage(res as ResponsesResponse),
    createStreamHandler: createOpenAIStreamHandler,
};

const embeddingsCreate: MethodSpec<EmbeddingsArgs, EmbeddingsResponse> = {
    path: ["embeddings", "create"],
    extractMeta: (args) => ({ model: (args as EmbeddingsArgs).model, isStream: false }),
    extractUsage: (res) => embeddingsUsage(res as EmbeddingsResponse),
};

const betaChatParse: MethodSpec<ChatArgs, ChatResponse> = {
    path: ["beta", "chat", "completions", "parse"],
    optional: true,
    extractMeta: (args) => ({ model: (args as ChatArgs).model, isStream: false }),
    extractUsage: (res) => chatUsage(res as ChatResponse),
};

const openaiMethods: readonly MethodSpec[] = [
    chatCompletionsCreate as MethodSpec,
    responsesCreate as MethodSpec,
    embeddingsCreate as MethodSpec,
    betaChatParse as MethodSpec,
];

export const openaiManifest: ProviderManifest = {
    provider: "openai",
    methods: openaiMethods,
    detect: structurallyMatches(openaiMethods),
};
