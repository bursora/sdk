/**
 * DeepSeek provider manifests.
 *
 * DeepSeek ships no first-party SDK. Users wrap either the `openai` package
 * (default) or `@anthropic-ai/sdk` (via the `/anthropic` compat endpoint) and
 * override `baseURL` to point at `api.deepseek.com`. The response shapes are
 * already covered by the existing OpenAI/Anthropic extractors — DeepSeek
 * mirrors `prompt_tokens_details.cached_tokens`, ships `usage` in the final
 * stream chunk without `stream_options.include_usage`, and uses the standard
 * OpenAI error envelope.
 *
 * These manifests reuse the existing methods so token math stays single-
 * sourced, but tag emitted events with `provider: "deepseek"` so backend
 * pricing lookup hits the correct catalog. Detection is gated on `baseURL`
 * inspection via the shared `baseURLIncludes` primitive; the wrap engine
 * tries DeepSeek variants before plain OpenAI / Anthropic so a deepseek-
 * flavored client wins.
 */

import { and, baseURLIncludes, structurallyMatches } from "../internal/detect";
import type { ProviderManifest } from "../types";
import { anthropicManifest } from "./anthropic";
import { openaiManifest } from "./openai";

const PROVIDER = "deepseek";
const hasDeepseekURL = baseURLIncludes("deepseek");

export const deepseekOpenaiManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: openaiManifest.methods,
    detect: and(structurallyMatches(openaiManifest.methods), hasDeepseekURL),
};

export const deepseekAnthropicManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: anthropicManifest.methods,
    detect: and(structurallyMatches(anthropicManifest.methods), hasDeepseekURL),
};
