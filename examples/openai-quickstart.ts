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

// In serverless / short-lived processes (Lambda, Cloudflare Workers, CLIs),
// drain pending usage events before the host exits so they reach the dashboard.
await openai.flush();
// In long-lived handlers (Next.js HMR, repeated wrap cycles), release the
// wrapper's beforeExit listener slot once you're done with it.
openai.dispose();
// endregion

export { openai };
