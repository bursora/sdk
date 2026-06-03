/**
 * Google Gemini provider manifest (native `@google/genai` shape).
 *
 * Gemini's OpenAI-compatible endpoint is already covered by the baseURL→vendor
 * map (an `OpenAI` client pointed at `generativelanguage.googleapis.com`). This
 * manifest instead instruments the NATIVE `@google/genai` client, which differs
 * from OpenAI in two ways:
 *
 *  - Calls are `models.generateContent({ model, contents })` and the streaming
 *    `models.generateContentStream(...)` — two distinct methods, not a `stream`
 *    flag on one method.
 *  - Usage lives on `usageMetadata` with camelCase counts:
 *    `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`,
 *    plus optional `cachedContentTokenCount`, `thoughtsTokenCount`, and
 *    `toolUsePromptTokenCount`.
 *
 * Instrumented methods:
 *  - `models.generateContent` / `models.generateContentStream` — text/multimodal
 *    generation. Full token usage from `usageMetadata`.
 *  - `chats.create(...)` → `Chat.sendMessage` / `sendMessageStream` — stateful
 *    multi-turn chat. The returned Chat is proxied so its send methods route
 *    through the lifecycle; the model is captured from the `create` call. The
 *    responses reuse the `generateContent` usage extractor and stream handler.
 *  - `models.embedContent` — embeddings. The response carries NO `usageMetadata`
 *    (Gemini bills embeddings by input token but returns no count), so the call
 *    gates against the budget and records, but with zero tokens.
 *  - `models.generateImages` — Imagen generation. Billed per image, not per
 *    token; the response carries no usage, so it also gates and records at zero
 *    tokens. Same degrade the OpenAI manifest applies to DALL-E.
 *  - `models.editImage` / `upscaleImage` / `recontextImage` / `segmentImage` —
 *    Gemini Enterprise Agent Platform (Vertex AI) image ops, also per-image and
 *    zero-token. They reject on Developer-API clients; on Vertex-backed clients
 *    they gate and record.
 *
 * Token mapping decisions (kept consistent with the OpenAI manifest):
 *  - `cachedContentTokenCount` is a SUBSET of `promptTokenCount` (the cached
 *    portion of the prompt, billed at the cheaper cache rate). It is split out
 *    so pricing meters it separately: `promptTokens = promptTokenCount - cached`,
 *    `cacheTokens = cached`. Same subtraction the OpenAI manifest applies to
 *    `prompt_tokens_details.cached_tokens`.
 *  - `toolUsePromptTokenCount` (tokens from tool-execution results fed back to
 *    the model as input — function calling, code execution, grounding) is a
 *    SEPARATE addend in `totalTokenCount`, not part of `promptTokenCount`. It is
 *    billed at the input rate, so it folds into the prompt count.
 *  - `thoughtsTokenCount` (Gemini "thinking" tokens) is billed at the output
 *    token rate and is reported SEPARATELY from `candidatesTokenCount`. It is
 *    folded into completion: `completionTokens = candidatesTokenCount +
 *    thoughtsTokenCount`, so the recorded cost matches the bill.
 *
 * No runtime dependency on `@google/genai` — detection is purely structural.
 */

import {
    type ChunkReading,
    createCumulativeStreamHandler,
} from "../internal/cumulative-stream-handler";
import { structurallyMatches } from "../internal/detect";
import type { FactorySpec, MethodSpec, ProviderManifest, UsageDelta, UsageTotals } from "../types";

const PROVIDER = "google";

interface ModelArgs {
    readonly model: string;
}

interface GoogleUsageMetadata {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
    readonly cachedContentTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly toolUsePromptTokenCount?: number;
}

interface GenerateContentResponse {
    readonly responseId?: string;
    readonly usageMetadata?: GoogleUsageMetadata;
}

// `embedContent` and `generateImages` return no `usageMetadata`. Embeddings bill
// by input token (count not reported); Imagen bills per image. Both still gate
// and record, carrying zero tokens — the same degrade the OpenAI manifest
// applies to per-image / per-second models that report no token usage.
const NO_TOKEN_USAGE: UsageTotals = { promptTokens: 0, completionTokens: 0 };

function generateContentUsage(response: GenerateContentResponse): UsageTotals {
    const u = response.usageMetadata;
    const cache = u?.cachedContentTokenCount ?? 0;
    const totalPrompt = (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0);
    const completion = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
    return {
        promptTokens: Math.max(0, totalPrompt - cache),
        completionTokens: completion,
        ...(cache > 0 ? { cacheTokens: cache } : {}),
        ...(response.responseId !== undefined ? { requestId: response.responseId } : {}),
    };
}

// Gemini reports `usageMetadata` as cumulative running totals, typically on the
// final stream chunk (intermediate chunks may carry partial or no usage).
// `prompt` folds tool-use input tokens in and `completion` folds thinking tokens
// in, just like the non-stream path; a null usage still counts as present
// (`hasUsage`) here, matching the prior behavior. The shared handler does the
// latest-wins delta math.
function googleChunkReading(raw: unknown): ChunkReading {
    const chunk = raw as GenerateContentResponse;
    const u = chunk.usageMetadata;
    const hasPrompt = u?.promptTokenCount !== undefined || u?.toolUsePromptTokenCount !== undefined;
    const hasCompletion =
        u?.candidatesTokenCount !== undefined || u?.thoughtsTokenCount !== undefined;
    return {
        prompt: hasPrompt
            ? (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0)
            : undefined,
        completion: hasCompletion
            ? (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
            : undefined,
        cache: u?.cachedContentTokenCount,
        requestId: chunk.responseId,
        hasUsage: u !== undefined,
    };
}

export function createGoogleStreamHandler(): (chunk: unknown) => UsageDelta | null {
    return createCumulativeStreamHandler(googleChunkReading);
}

const generateContent: MethodSpec<ModelArgs, GenerateContentResponse> = {
    path: ["models", "generateContent"],
    extractMeta: (args) => ({ model: args.model, isStream: false }),
    extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
};

const generateContentStream: MethodSpec<
    ModelArgs,
    GenerateContentResponse,
    GenerateContentResponse
> = {
    path: ["models", "generateContentStream"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: true }),
    extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
    createStreamHandler: createGoogleStreamHandler,
};

// Methods that gate and record but report no token usage. `embedContent` and
// `generateImages` are Gemini Developer API; the rest are Gemini Enterprise
// Agent Platform (Vertex AI) image ops. All are keyed only by `model` and
// return no `usageMetadata`, so they share one generated spec.
const ZERO_TOKEN_PATHS: readonly (readonly string[])[] = [
    ["models", "embedContent"],
    ["models", "generateImages"],
    ["models", "editImage"],
    ["models", "upscaleImage"],
    ["models", "recontextImage"],
    ["models", "segmentImage"],
];

const zeroTokenMethods: readonly MethodSpec[] = ZERO_TOKEN_PATHS.map((path) => ({
    path,
    optional: true,
    extractMeta: (args) => ({ model: (args as ModelArgs).model, isStream: false }),
    extractUsage: () => NO_TOKEN_USAGE,
}));

// `chats.create({ model })` returns a stateful Chat whose `sendMessage` and
// `sendMessageStream` return the same `GenerateContentResponse` shape as
// `generateContent`, so they reuse its usage extractor and stream handler. The
// model is bound at create time, not passed per message.
const chatsCreate: FactorySpec = {
    path: ["chats", "create"],
    extractModel: (args) => (args as ModelArgs).model,
    methods: [
        {
            name: "sendMessage",
            isStream: false,
            extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
        },
        {
            name: "sendMessageStream",
            isStream: true,
            extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
            createStreamHandler: createGoogleStreamHandler,
        },
    ],
};

const googleMethods: readonly MethodSpec[] = [
    generateContent as MethodSpec,
    generateContentStream as MethodSpec,
    ...zeroTokenMethods,
];

export const googleManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: googleMethods,
    factories: [chatsCreate],
    detect: structurallyMatches(googleMethods),
};
