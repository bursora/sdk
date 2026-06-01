/** Quickstart. The region below is the verbatim snippet for the onboarding quickstart. */

// region:ai-sdk-quickstart
import { openai } from "@ai-sdk/openai";
import { bursoraMiddleware } from "@bursora/sdk";
import { generateText, wrapLanguageModel } from "ai";

// Workspace: "__BURSORA_WORKSPACE_ID__"
// On the `ai` package you never construct a provider client, so wrap() has
// nothing to wrap. bursoraMiddleware plugs into the AI SDK's own slot: it
// gates the budget before each call and records what the call spent.
const model = wrapLanguageModel({
    model: openai("gpt-4o-mini"),
    middleware: bursoraMiddleware({
        apiKey: "__BURSORA_API_KEY__",
        endpoint: "__BURSORA_ENDPOINT__",
    }),
});

await generateText({ model, prompt: "Say hi" });
// endregion

export { model };
