# @bursora/sdk

[![npm](https://img.shields.io/npm/v/@bursora/sdk?style=flat-square&color=2563eb)](https://www.npmjs.com/package/@bursora/sdk)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@bursora/sdk?style=flat-square&label=minzip)](https://bundlephobia.com/package/@bursora/sdk)
[![types](https://img.shields.io/npm/types/@bursora/sdk?style=flat-square)](https://bursora.com/docs/sdk/install)
[![license](https://img.shields.io/npm/l/@bursora/sdk?style=flat-square)](./LICENSE)

> Catch the runaway AI bill before it happens. One line around your provider client.

AI calls bill by token. A stuck loop, a runaway agent, or one abusive customer can burn hundreds of dollars before anyone looks at a graph. Most tools show you the damage after it lands. Bursora checks the budget _before_ the call goes out and blocks it if it would blow a limit. Traffic light, not speed camera.

This package is the wrap. No proxy, no gateway; your app still talks straight to OpenAI, Anthropic, or Google. Bursora just gets a yes/no first, then the real token cost after.

## Install

```bash
npm i @bursora/sdk
```

Bring your own provider client (`openai`, `@anthropic-ai/sdk`, `@google/genai`, ...). The SDK detects them by shape, so it never bundles them.

## 30 seconds

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
            // over budget: downgrade the model, queue it, show a fallback
        } else throw e;
    }
});
```

Tag each call with who it's for (customer, agent, workflow). That's how spend gets grouped in the dashboard and how budgets know what to scope to.

## What you get

- **Block before spend.** Over a hard limit? `BudgetExceededError` throws before the provider is ever called. No charge.
- **Soft limits.** Notify and throttle modes let the call through and report after.
- **Fail open.** Can't reach Bursora? Your call still goes out. We don't become your outage.
- **Streaming-safe.** Chunks pass through untouched; usage is read off the final one.
- Decisions cache for 60 seconds; usage flushes after each call.

## More providers

OpenAI, Anthropic, and Google Gemini all wrap exactly like the example above; detection is by client shape. Bedrock has its own `wrapBedrock`. And on the Vercel AI SDK (`ai`) you use `bursoraMiddleware` with `wrapLanguageModel` instead of `wrap`, since `generateText` never constructs a client for `wrap` to see.

Pick yours and copy the snippet:

- **[OpenAI](https://bursora.com/docs/sdk/providers/openai)** · **[Anthropic](https://bursora.com/docs/sdk/providers/anthropic)** · **[Google](https://bursora.com/docs/sdk/providers/google)**
- **[Amazon Bedrock](https://bursora.com/docs/sdk/providers/bedrock)**
- **[DeepSeek, Groq, xAI, Mistral and other OpenAI-compatible](https://bursora.com/docs/sdk/providers/openai-compatible)**
- **[Vercel AI SDK](https://bursora.com/docs/sdk/ai-sdk)**

Tags, batch metering, sharing one core across clients, budget snapshots, error handling: it's all in the docs. Start at **[bursora.com/docs/sdk/install](https://bursora.com/docs/sdk/install)**.

## API key

Sign in at [bursora.com](https://bursora.com), create a workspace, grab your `BURSORA_API_KEY`.

## License

MIT. © 2026 Vildan Bina.
