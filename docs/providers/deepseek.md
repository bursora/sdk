# DeepSeek

DeepSeek ships no first-party SDK. You reuse the `openai` package (or `@anthropic-ai/sdk` for the Anthropic-compatible endpoint) and override `baseURL`. The wrap detects the override and tags events with `provider: "deepseek"` so backend pricing lookup hits the DeepSeek catalog.

## Install

```bash
npm i openai @bursora/sdk
# or, for the Anthropic-compatible endpoint:
npm i @anthropic-ai/sdk @bursora/sdk
```

## Setup (OpenAI shape)

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

export const deepseek = wrap(
    new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
    }),
    {
        apiKey: process.env.BURSORA_API_KEY!,
        endpoint: process.env.BURSORA_ENDPOINT!,
    },
);
```

Detection: the wrap reads the client's `baseURL` and matches against `"deepseek"`. Anything else falls back to the plain OpenAI manifest.

## Setup (Anthropic shape)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "@bursora/sdk";

export const deepseek = wrap(
    new Anthropic({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/anthropic",
    }),
    {
        apiKey: process.env.BURSORA_API_KEY!,
        endpoint: process.env.BURSORA_ENDPOINT!,
    },
);
```

The Anthropic-compatible endpoint mirrors the messages API shape.

## Chat

```ts
const res = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "Sum 2 + 2." }],
});

console.log(res.choices[0]?.message?.content);
```

Token math: same as OpenAI's chat completions (DeepSeek mirrors `prompt_tokens_details.cached_tokens`).

## Models

| Model | Notes |
| --- | --- |
| `deepseek-chat` | General chat |
| `deepseek-reasoner` | Reasoning model |

Bursora's pricing catalog tracks both. See the [Pricing page](../../concepts/pricing.md).

## Streaming

```ts
const stream = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

DeepSeek emits `usage` on the final stream chunk without needing `stream_options.include_usage`. Token tracking works out of the box.

## With tags

```ts
import { withTags } from "@bursora/sdk";

await withTags({ tenant_id: "acme" }, async () => {
    await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
    });
});
```

## Sharing a core with OpenAI

```ts
import OpenAI from "openai";
import { createBursora, wrap } from "@bursora/sdk";

const core = createBursora({
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

export const openai = wrap(new OpenAI(), core);

export const deepseek = wrap(
    new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
    }),
    core,
);
```

Both wrapped clients share one decision cache and one events queue. One `core.flush()` drains both.

## Error handling

DeepSeek follows the OpenAI error envelope, so:

```ts
import { APIError } from "openai";
import { BudgetExceededError } from "@bursora/sdk";

try {
    await deepseek.chat.completions.create({ ... });
} catch (err) {
    if (err instanceof BudgetExceededError) return fallback();
    if (err instanceof APIError) return retryOrSurface(err);
    throw err;
}
```

## Why a baseURL override

The wrap's detection logic is order-sensitive:

1. DeepSeek (OpenAI shape) - matches when client has OpenAI shape AND `baseURL` contains `"deepseek"`.
2. DeepSeek (Anthropic shape) - matches when client has Anthropic shape AND `baseURL` contains `"deepseek"`.
3. OpenAI - matches the OpenAI shape (no `baseURL` gate).
4. Anthropic - matches the Anthropic shape (no `baseURL` gate).

DeepSeek manifests try first; a DeepSeek-flavored client wins over plain OpenAI/Anthropic. Without the order, events would tag with the wrong provider and pricing would miss.

## Next

- [OpenAI](openai.md)
- [Anthropic](anthropic.md)
- [wrap()](../wrap.md)
