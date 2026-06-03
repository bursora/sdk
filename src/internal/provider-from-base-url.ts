/**
 * Resolves a canonical provider slug from a wrapped client's `baseURL`.
 *
 * Every OpenAI-compatible vendor is the same `new OpenAI({ baseURL })` with the
 * same `usage` shape; only the host distinguishes them. Rather than a manifest
 * per vendor, the wrap engine reads `client.baseURL` at call time and maps it
 * to the slug used for backend pricing lookup. A host the map doesn't know
 * falls back to the adapter's native provider, so an unpriced model lands on
 * the existing UnknownPricingError path instead of being mislabeled.
 */

// Host substring → canonical slug. First match wins; each entry is tested as a
// substring of the full baseURL so path-style compat endpoints (e.g.
// `.../deepseek.com/anthropic`) still resolve.
const HOST_VENDORS: readonly (readonly [string, string])[] = [
    ["api.deepseek.com", "deepseek"],
    ["api.groq.com", "groq"],
    ["api.x.ai", "xai"],
    ["api.mistral.ai", "mistral"],
    ["api.together.xyz", "together"],
    ["api.fireworks.ai", "fireworks"],
    ["api.perplexity.ai", "perplexity"],
    ["openrouter.ai", "openrouter"],
    ["ai-gateway.vercel.sh", "vercel"],
    ["localhost:11434", "ollama"],
    ["api.anthropic.com", "anthropic"],
    ["generativelanguage.googleapis.com", "google"],
    ["api.openai.com", "openai"],
];

export function providerFromBaseURL(client: object, fallback: string): string {
    const url = (client as { baseURL?: unknown }).baseURL;
    if (typeof url !== "string") return fallback;
    for (const [host, slug] of HOST_VENDORS) {
        if (url.includes(host)) return slug;
    }
    return fallback;
}
