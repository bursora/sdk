/** Quickstart. The region below is embedded verbatim in docs/onboarding.md. */

// region:deepseek-quickstart
import { wrap } from "@bursora/sdk";
import OpenAI from "openai";

// Workspace: "__BURSORA_WORKSPACE_ID__"
// DeepSeek ships no first-party SDK; reuse the `openai` package and point
// baseURL at api.deepseek.com. The wrapper detects the override and tags
// events with provider: "deepseek".
const deepseek = wrap(
    new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
    }),
    {
        apiKey: "__BURSORA_API_KEY__",
        endpoint: "__BURSORA_ENDPOINT__",
    },
);

await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "Say hi" }],
});

await deepseek.flush();
deepseek.dispose();
// endregion

export { deepseek };
