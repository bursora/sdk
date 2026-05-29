/** Quickstart. The region below is embedded verbatim in docs/onboarding.md. */

// region:openai-quickstart
import { wrap } from "@bursora/sdk";
import OpenAI from "openai";

// Workspace: "__BURSORA_WORKSPACE_ID__"
const openai = wrap(new OpenAI(), {
    apiKey: "__BURSORA_API_KEY__",
    endpoint: "__BURSORA_ENDPOINT__",
});

await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Say hi" }],
});
// endregion

export { openai };
