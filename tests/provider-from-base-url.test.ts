/**
 * providerFromBaseURL — host → canonical vendor slug.
 *
 * Every OpenAI-compatible vendor shares one client shape; the baseURL host is
 * what tells them apart. These tests pin the map: known hosts resolve to their
 * slug, unknown or missing/non-string baseURLs fall back to the adapter's
 * native provider so unpriced models land on the existing UnknownPricing path.
 */

import { describe, expect, test } from "bun:test";
import { providerFromBaseURL } from "../src/internal/provider-from-base-url";

const cases: ReadonlyArray<readonly [string, string]> = [
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.deepseek.com/anthropic", "deepseek"],
    ["https://api.groq.com/openai/v1", "groq"],
    ["https://api.x.ai/v1", "xai"],
    ["https://api.mistral.ai/v1", "mistral"],
    ["https://api.together.xyz/v1", "together"],
    ["https://api.fireworks.ai/inference/v1", "fireworks"],
    ["https://api.perplexity.ai", "perplexity"],
    ["https://api.cerebras.ai/v1", "cerebras"],
    ["https://api.deepinfra.com/v1/openai", "deepinfra"],
    ["https://api.sambanova.ai/v1", "sambanova"],
    ["https://api.studio.nebius.ai/v1", "nebius"],
    ["https://api.novita.ai/v3/openai", "novita"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://ai-gateway.vercel.sh/v1", "vercel"],
    ["http://localhost:11434/v1", "ollama"],
    ["https://api.anthropic.com/v1", "anthropic"],
    ["https://generativelanguage.googleapis.com/v1beta/openai", "google"],
    ["https://api.openai.com/v1", "openai"],
];

describe("providerFromBaseURL", () => {
    for (const [url, slug] of cases) {
        test(`${url} → ${slug}`, () => {
            expect(providerFromBaseURL({ baseURL: url }, "openai")).toBe(slug);
        });
    }

    test("unknown host falls back to the adapter's native provider", () => {
        expect(providerFromBaseURL({ baseURL: "https://api.example.com/v1" }, "openai")).toBe(
            "openai",
        );
        expect(providerFromBaseURL({ baseURL: "https://api.example.com/v1" }, "anthropic")).toBe(
            "anthropic",
        );
    });

    test("missing baseURL falls back", () => {
        expect(providerFromBaseURL({}, "openai")).toBe("openai");
    });

    test("non-string baseURL falls back", () => {
        expect(providerFromBaseURL({ baseURL: 42 }, "openai")).toBe("openai");
        expect(
            providerFromBaseURL({ baseURL: { toString: () => "https://api.groq.com" } }, "openai"),
        ).toBe("openai");
    });
});
