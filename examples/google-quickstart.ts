/** Quickstart. The region below is the verbatim snippet for the onboarding quickstart. */

// region:google-quickstart
import { wrap } from "@bursora/sdk";
import { GoogleGenAI } from "@google/genai";

// Workspace: "__BURSORA_WORKSPACE_ID__"
// Native Gemini client (@google/genai). Bursora detects it by shape (no
// baseURL override) and tags events with provider: "google".
const genai = wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }), {
    apiKey: "__BURSORA_API_KEY__",
    endpoint: "__BURSORA_ENDPOINT__",
});

await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Say hi",
});
// endregion

export { genai };
