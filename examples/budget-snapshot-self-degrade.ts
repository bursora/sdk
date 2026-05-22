/**
 * Budget snapshot self-degrade. The region below is embedded verbatim in
 * docs/onboarding.md. Read `openai.budget` between calls to skip optional
 * work before the next pre-call check fires a block.
 */

// region:budget-snapshot-self-degrade
import { withTags, wrap } from "@bursora/sdk";
import OpenAI from "openai";

const openai = wrap(new OpenAI(), {
    apiKey: "__BURSORA_API_KEY__",
    endpoint: "__BURSORA_ENDPOINT__",
});

async function reply(tenantId: string, question: string) {
    return withTags({ tenant_id: tenantId }, async () => {
        const snap = openai.budget;
        if (snap && snap.remainingUsd < 0.05) {
            // Headroom thin: skip the optional rerank call, serve a fallback.
            return { degraded: true as const, text: "Quick answer (budget low)." };
        }
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: question }],
            stream: false,
        });
        const text = res.choices[0]?.message?.content ?? "";
        return { degraded: false as const, text };
    });
}
// endregion

export { reply };
