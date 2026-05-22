/**
 * Quickstart: wrap an Anthropic client with Bursora.
 *
 * Marked region below is the verbatim snippet for the runbook. Imports plus
 * one wrapped call — enough for a user to copy, paste, and see a row in the
 * dashboard.
 */

// region:anthropic-quickstart
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "@bursora/sdk";

// Workspace: "__BURSORA_WORKSPACE_ID__"
const anthropic = wrap(new Anthropic(), {
    apiKey: "__BURSORA_API_KEY__",
    endpoint: "__BURSORA_ENDPOINT__",
});

await anthropic.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 256,
    messages: [{ role: "user", content: "Say hi" }],
});
// endregion

export { anthropic };
