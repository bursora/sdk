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
 *    plus optional `cachedContentTokenCount` and `thoughtsTokenCount`.
 *
 * Token mapping decisions (kept consistent with the OpenAI manifest):
 *  - `cachedContentTokenCount` is a SUBSET of `promptTokenCount` (the cached
 *    portion of the prompt, billed at the cheaper cache rate). It is split out
 *    so pricing meters it separately: `promptTokens = promptTokenCount - cached`,
 *    `cacheTokens = cached`. Same subtraction the OpenAI manifest applies to
 *    `prompt_tokens_details.cached_tokens`.
 *  - `thoughtsTokenCount` (Gemini "thinking" tokens) is billed at the output
 *    token rate and is reported SEPARATELY from `candidatesTokenCount`. It is
 *    folded into completion: `completionTokens = candidatesTokenCount +
 *    thoughtsTokenCount`, so the recorded cost matches the bill.
 *
 * No runtime dependency on `@google/genai` — detection is purely structural.
 */

import { structurallyMatches } from "../internal/detect";
import type { MethodSpec, ProviderManifest, UsageDelta, UsageTotals } from "../types";

const PROVIDER = "google";

interface GenerateContentArgs {
    readonly model: string;
}

interface GoogleUsageMetadata {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
    readonly cachedContentTokenCount?: number;
    readonly thoughtsTokenCount?: number;
}

interface GenerateContentResponse {
    readonly responseId?: string;
    readonly usageMetadata?: GoogleUsageMetadata;
}

function generateContentUsage(response: GenerateContentResponse): UsageTotals {
    const u = response.usageMetadata;
    const cache = u?.cachedContentTokenCount ?? 0;
    const totalPrompt = u?.promptTokenCount ?? 0;
    const completion = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
    return {
        promptTokens: Math.max(0, totalPrompt - cache),
        completionTokens: completion,
        ...(cache > 0 ? { cacheTokens: cache } : {}),
        ...(response.responseId !== undefined ? { requestId: response.responseId } : {}),
    };
}

// Gemini reports `usageMetadata` as cumulative running totals, typically on the
// final stream chunk (intermediate chunks may carry partial or no usage). The
// handler tracks the latest seen totals and emits deltas relative to the last
// emitted figure so the engine's sum-of-deltas matches the final totals — the
// same latest-wins pattern the OpenAI stream handler uses.
export function createGoogleStreamHandler(): (chunk: unknown) => UsageDelta | null {
    let promptTotal = 0;
    let completionTotal = 0;
    let cacheTotal = 0;
    let lastEmittedPromptUncached = 0;
    let lastEmittedCompletion = 0;
    let lastEmittedCache = 0;
    let requestId: string | undefined;

    return (raw: unknown) => {
        const chunk = raw as GenerateContentResponse;
        if (requestId === undefined && chunk.responseId !== undefined) requestId = chunk.responseId;
        const u = chunk.usageMetadata;
        if (u === undefined && chunk.responseId === undefined) return null;

        if (u?.promptTokenCount !== undefined) promptTotal = u.promptTokenCount;
        if (u?.cachedContentTokenCount !== undefined) cacheTotal = u.cachedContentTokenCount;
        if (u?.candidatesTokenCount !== undefined || u?.thoughtsTokenCount !== undefined) {
            completionTotal = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
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

const generateContent: MethodSpec<GenerateContentArgs, GenerateContentResponse> = {
    path: ["models", "generateContent"],
    extractMeta: (args) => ({ model: args.model, isStream: false }),
    extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
};

const generateContentStream: MethodSpec<
    GenerateContentArgs,
    GenerateContentResponse,
    GenerateContentResponse
> = {
    path: ["models", "generateContentStream"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: true }),
    extractUsage: (res) => generateContentUsage(res as GenerateContentResponse),
    createStreamHandler: createGoogleStreamHandler,
};

const googleMethods: readonly MethodSpec[] = [
    generateContent as MethodSpec,
    generateContentStream as MethodSpec,
];

export const googleManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: googleMethods,
    detect: structurallyMatches(googleMethods),
};
