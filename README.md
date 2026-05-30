# @bursora/sdk

Wrap your AI provider clients to enforce per-agent, per-tenant, and per-workflow
budgets. Decisions cache for 60 seconds; usage reports flush after each call.

## Install

```bash
npm i @bursora/sdk
# or: bun add @bursora/sdk
# or: pnpm add @bursora/sdk
```

You also install the provider client of your choice (`openai`,
`@anthropic-ai/sdk`, or `@google/genai`; DeepSeek reuses `openai`). The SDK uses
structural typing, so it does not bundle them.

## Usage

```ts
import OpenAI from "openai";
import { BudgetExceededError, withTags, wrap } from "@bursora/sdk";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

await withTags({ tenant_id: "acme", agent_id: "support-bot" }, async () => {
    try {
        await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
    } catch (e) {
        if (e instanceof BudgetExceededError) {
            // budget hit — render fallback or downgrade model
        } else {
            throw e;
        }
    }
});
```

## Other providers

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "@bursora/sdk";

const anthropic = wrap(new Anthropic(), { apiKey, endpoint });
```

Google Gemini's native client (`@google/genai`) is detected by shape too. Wrap
it the same way; calls go through `models.generateContent` and
`models.generateContentStream`.

```ts
import { GoogleGenAI } from "@google/genai";
import { wrap } from "@bursora/sdk";

const genai = wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }), {
    apiKey,
    endpoint,
});

await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "hi",
});
```

DeepSeek has no first-party SDK; reuse the `openai` package and override
`baseURL`. The wrapper detects the override and tags events accordingly.

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

const deepseek = wrap(
    new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
    }),
    { apiKey, endpoint },
);
```

## Vercel AI SDK

Apps on the `ai` package call `generateText({ model })` instead of constructing
a provider client, so `wrap()` never sees those calls. Use `bursoraMiddleware`
with `wrapLanguageModel` instead. It gates each call before it goes out (a
block-mode denial throws `BudgetExceededError` out of `generateText`) and meters
every step of a tool loop after. `ai` is an optional peer dependency.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { bursoraMiddleware } from "@bursora/sdk";

const model = wrapLanguageModel({
    model: openai("gpt-4o"),
    middleware: bursoraMiddleware({
        apiKey,
        endpoint,
        tags: { tenant_id: "acme", agent_id: "support-bot" },
    }),
});

await generateText({ model, prompt: "hi" });
```

## Sharing one core across clients

`wrap(client, { apiKey, endpoint })` builds a private decision cache + events
queue for that wrapped client. If you wrap several providers and want them to
share one queue (so a single `flush()` drains all of them), build the core
yourself with `createBursora` and pass it in.

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createBursora, wrap } from "@bursora/sdk";

const core = createBursora({ apiKey, endpoint });
const openai = wrap(new OpenAI(), core);
const anthropic = wrap(new Anthropic(), core);

// ...calls...
await core.flush();
core.dispose();
```

## Behaviour

- Pre-call: SDK checks `/api/v1/budget` (60 s decision cache).
- Block mode: SDK throws `BudgetExceededError` before the provider call. No
  provider charge.
- Notify / throttle: SDK calls the provider; events are emitted post-call.
- Fail open: if Bursora is unreachable, your call still goes through.
- Streaming: chunks pass through unchanged; usage is read from the final chunk.

## API key

Sign in at [bursora.com](https://bursora.com) to get your `BURSORA_API_KEY`.

## License

Apache License 2.0. Copyright (c) 2026 Vildan Bina.
