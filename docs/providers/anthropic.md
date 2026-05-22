# Anthropic

`wrap(new Anthropic(), { apiKey, endpoint })` returns a wrapped Anthropic client.

## Install

```bash
npm i @anthropic-ai/sdk @bursora/sdk
```

## Setup

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "@bursora/sdk";

export const anthropic = wrap(new Anthropic(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});
```

The Anthropic client reads `ANTHROPIC_API_KEY` from the env by default.

## Instrumented methods

| Method            | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `messages.create` | Messages API (the one method Anthropic ships) |

## Messages

```ts
const res = await anthropic.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 256,
    messages: [{ role: "user", content: "Sum 2 + 2." }],
});

console.log(res.content[0]);
```

Token math (from `response.usage`):

- `promptTokens` = `input_tokens`
- `completionTokens` = `output_tokens`
- `cacheTokens` = `cache_creation_input_tokens + cache_read_input_tokens`

Cache write and cache read tokens are summed; if you want them split, file an issue.

## Streaming

```ts
const stream = await anthropic.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
});

for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
    }
}
```

Unlike OpenAI, Anthropic streams ship usage automatically. No options to flip.

How the SDK reads usage from a stream:

- `message_start.message.usage.input_tokens` - the prompt count; output is always 0 at that point.
- `message_delta.usage.output_tokens` - the **cumulative** running total (not incremental).

The SDK closes over the running total per stream so the engine's sum-of-deltas matches Anthropic's final cumulative figure.

## With tags

```ts
import { withTags } from "@bursora/sdk";

await withTags({ tenant_id: "acme" }, async () => {
    await anthropic.messages.create({
        model: "claude-3-5-haiku-latest",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
    });
});
```

See [withTags()](../with-tags.md).

## Headroom snapshot

```ts
const snap = anthropic.budget;
```

See [budget snapshot](../budget-snapshot.md).

## Sharing a core with OpenAI

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createBursora, wrap } from "@bursora/sdk";

const core = createBursora({
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

export const openai = wrap(new OpenAI(), core);
export const anthropic = wrap(new Anthropic(), core);
```

See [shared core](../shared-core.md).

## Error handling

```ts
import Anthropic from "@anthropic-ai/sdk";
import { BudgetExceededError } from "@bursora/sdk";

try {
    await anthropic.messages.create({ ... });
} catch (err) {
    if (err instanceof BudgetExceededError) {
        // Bursora denied; provider not hit
        return fallback();
    }
    if (err instanceof Anthropic.APIError) {
        // 429, content filter, etc.
        return retryOrSurface(err);
    }
    throw err;
}
```

See [errors](../errors.md).

## Compatibility

| `@anthropic-ai/sdk` package | Status    |
| --------------------------- | --------- |
| Latest                      | supported |

## Next

- [OpenAI](openai.md)
- [DeepSeek](deepseek.md)
- [wrap()](../wrap.md)
