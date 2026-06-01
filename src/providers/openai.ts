/**
 * OpenAI provider manifest.
 *
 * Declares the four OpenAI client methods Bursora instruments
 * (`chat.completions.create`, `responses.create`, `embeddings.create`,
 * `chat.completions.parse`) plus per-method usage extractors. The
 * generic `wrap()` engine reads this manifest to assemble the Proxy.
 */

import {
    type ChunkReading,
    createCumulativeStreamHandler,
} from "../internal/cumulative-stream-handler";
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

// OpenAI reports usage as cumulative totals (typically once, on a terminal
// chunk), but a chunk can legitimately carry `cached_tokens` without
// `prompt_tokens`. `hasUsage` is `usage` being a real object (a null usage
// counts as no usage here); the shared handler does the latest-wins delta math.
function openaiChunkReading(raw: unknown): ChunkReading {
    const chunk = raw as OpenAIStreamChunk;
    const u = chunk.usage;
    return {
        prompt: u?.prompt_tokens,
        completion: u?.completion_tokens,
        cache: u?.prompt_tokens_details?.cached_tokens,
        requestId: chunk.id,
        hasUsage: u != null,
    };
}

export function createOpenAIStreamHandler(): (chunk: unknown) => UsageDelta | null {
    return createCumulativeStreamHandler(openaiChunkReading);
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

const chatParse: MethodSpec<ChatArgs, ChatResponse> = {
    path: ["chat", "completions", "parse"],
    optional: true,
    extractMeta: (args) => ({ model: (args as ChatArgs).model, isStream: false }),
    extractUsage: (res) => chatUsage(res as ChatResponse),
};

const openaiMethods: readonly MethodSpec[] = [
    chatCompletionsCreate as MethodSpec,
    responsesCreate as MethodSpec,
    embeddingsCreate as MethodSpec,
    chatParse as MethodSpec,
];

export const openaiManifest: ProviderManifest = {
    provider: "openai",
    methods: openaiMethods,
    detect: structurallyMatches(openaiMethods),
};
