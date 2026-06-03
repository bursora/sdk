/**
 * OpenAI provider manifest.
 *
 * Declares the OpenAI client methods Bursora instruments plus per-method usage
 * extractors; the generic `wrap()` engine reads this manifest to assemble the
 * Proxy. Instrumented: `chat.completions.create`, `chat.completions.parse`,
 * `responses.create`, `responses.parse`, `embeddings.create`,
 * `images.generate`, `images.edit`, and `audio.transcriptions.create`.
 *
 * Every instrumented method bills by token. Images and transcription report
 * token usage only on GPT-class models (gpt-image-1, gpt-4o-transcribe); legacy
 * models (DALL-E, whisper-1) bill per image / per second and report no token
 * usage, so those calls still gate and record but carry 0 tokens.
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

// Images and audio transcription on GPT-class models report token usage as
// `{ input_tokens, output_tokens }`. Transcription's usage is a union — the
// duration variant (whisper-1, billed per second) carries no `input_tokens`,
// so it falls through to 0 tokens, which is the intended degrade.
interface TokenUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
}
interface TokenUsageResponse {
    readonly usage?: TokenUsage;
}
interface ImageArgs {
    readonly model?: string | null;
    readonly stream?: boolean | null;
}
interface TranscriptionArgs {
    readonly model: string;
    readonly stream?: boolean | null;
}

// OpenAI defaults image generation to dall-e-2 when `model` is omitted; mirror
// that so an unspecified call is labeled with the model the provider will use.
const DEFAULT_IMAGE_MODEL = "dall-e-2";

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

function tokenPairUsage(u: TokenUsage | undefined): ManifestUsage {
    return {
        promptTokens: u?.input_tokens ?? 0,
        completionTokens: u?.output_tokens ?? 0,
    };
}

// Image and transcription streams carry usage exactly once, on their terminal
// event (`image_generation.completed`, `image_edit.completed`,
// `transcript.text.done`); every other event omits it. The shared cumulative
// handler emits that full total as a single delta. No cache or request id.
function tokenPairChunkReading(raw: unknown): ChunkReading {
    const u = (raw as TokenUsageResponse).usage;
    return {
        prompt: u?.input_tokens,
        completion: u?.output_tokens,
        cache: undefined,
        requestId: undefined,
        hasUsage: u != null,
    };
}

export function createTokenPairStreamHandler(): (chunk: unknown) => UsageDelta | null {
    return createCumulativeStreamHandler(tokenPairChunkReading);
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

const responsesParse: MethodSpec<ResponsesArgs, ResponsesResponse> = {
    path: ["responses", "parse"],
    optional: true,
    extractMeta: (args) => ({ model: (args as ResponsesArgs).model, isStream: false }),
    extractUsage: (res) => responsesUsage(res as ResponsesResponse),
};

const imagesGenerate: MethodSpec<ImageArgs, TokenUsageResponse> = {
    path: ["images", "generate"],
    optional: true,
    extractMeta: (args) => ({
        model: (args as ImageArgs).model ?? DEFAULT_IMAGE_MODEL,
        isStream: (args as ImageArgs).stream === true,
    }),
    extractUsage: (res) => tokenPairUsage((res as TokenUsageResponse).usage),
    createStreamHandler: createTokenPairStreamHandler,
};

const imagesEdit: MethodSpec<ImageArgs, TokenUsageResponse> = {
    path: ["images", "edit"],
    optional: true,
    extractMeta: (args) => ({
        model: (args as ImageArgs).model ?? DEFAULT_IMAGE_MODEL,
        isStream: (args as ImageArgs).stream === true,
    }),
    extractUsage: (res) => tokenPairUsage((res as TokenUsageResponse).usage),
    createStreamHandler: createTokenPairStreamHandler,
};

const audioTranscriptionsCreate: MethodSpec<TranscriptionArgs, TokenUsageResponse> = {
    path: ["audio", "transcriptions", "create"],
    optional: true,
    extractMeta: (args) => ({
        model: (args as TranscriptionArgs).model,
        isStream: (args as TranscriptionArgs).stream === true,
    }),
    extractUsage: (res) => tokenPairUsage((res as TokenUsageResponse).usage),
    createStreamHandler: createTokenPairStreamHandler,
};

const openaiMethods: readonly MethodSpec[] = [
    chatCompletionsCreate as MethodSpec,
    responsesCreate as MethodSpec,
    embeddingsCreate as MethodSpec,
    chatParse as MethodSpec,
    responsesParse as MethodSpec,
    imagesGenerate as MethodSpec,
    imagesEdit as MethodSpec,
    audioTranscriptionsCreate as MethodSpec,
];

export const openaiManifest: ProviderManifest = {
    provider: "openai",
    methods: openaiMethods,
    detect: structurallyMatches(openaiMethods),
};
