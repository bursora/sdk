/**
 * Quickstart: wrap an OpenAI client with Bursora for embeddings.
 *
 * Same manifest as the chat-completions quickstart — the OpenAI manifest also
 * routes `embeddings.create` through the Bursora decision lifecycle. The
 * marked region is the verbatim doc snippet.
 */

// region:openai-embeddings-quickstart
import { wrap } from "@bursora/sdk";
import OpenAI from "openai";

// Workspace: "__BURSORA_WORKSPACE_ID__"
const openai = wrap(new OpenAI(), {
    apiKey: "__BURSORA_API_KEY__",
    endpoint: "__BURSORA_ENDPOINT__",
});

await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: "hello world",
});
// endregion

export { openai };
