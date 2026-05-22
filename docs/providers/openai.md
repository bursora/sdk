# OpenAI

`wrap(new OpenAI(), { apiKey, endpoint })` returns a wrapped OpenAI client. Use it the way you used the original.

## Install

```bash
npm i openai @bursora/sdk
```

## Setup

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

export const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});
```

The OpenAI client reads `OPENAI_API_KEY` from the env by default; pass it explicitly if you keep it elsewhere.

## Instrumented methods

| Method | Purpose | Required |
| --- | --- | --- |
| `chat.completions.create` | Chat completions | yes |
| `responses.create` | Responses API | optional |
| `embeddings.create` | Embeddings | yes |
| `beta.chat.completions.parse` | Structured output | optional |

Methods marked optional are tolerated as missing if the OpenAI package version doesn't ship them. Required methods missing means `wrap()` throws.

## Chat completions

```ts
const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Sum 2 + 2." },
    ],
});

console.log(res.choices[0]?.message?.content);
```

Token math (from `response.usage`):

- `promptTokens` = `prompt_tokens - (prompt_tokens_details.cached_tokens ?? 0)`
- `completionTokens` = `completion_tokens`
- `cacheTokens` = `prompt_tokens_details.cached_tokens` (if present)

The split keeps cached tokens out of the prompt bucket so per-rate math matches OpenAI's billing.

## Streaming chat

```ts
const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    stream_options: { include_usage: true }, // required
    messages: [{ role: "user", content: "hi" }],
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

**Set `stream_options: { include_usage: true }`** or tokens record as zero. OpenAI emits the final usage block as the last chunk only when this option is on.

## Responses API

```ts
const res = await openai.responses.create({
    model: "gpt-4o-mini",
    input: "Sum 2 + 2.",
});
```

Token math (from `response.usage`):

- `promptTokens` = `input_tokens - (input_tokens_details.cached_tokens ?? 0)`
- `completionTokens` = `output_tokens`
- `cacheTokens` = `input_tokens_details.cached_tokens`

## Embeddings

```ts
const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: "hello world",
});
```

Token math (from `response.usage`):

- `promptTokens` = `prompt_tokens`
- `completionTokens` = `0`

## Structured output (`beta.chat.completions.parse`)

```ts
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const Schema = z.object({ city: z.string(), pop: z.number() });

const res = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Berlin population?" }],
    response_format: zodResponseFormat(Schema, "city_info"),
});

console.log(res.choices[0]?.message?.parsed);
```

Same token math as `chat.completions.create`.

## With tags

```ts
import { withTags } from "@bursora/sdk";

await withTags({ tenant_id: "acme", agent_id: "support-bot" }, async () => {
    await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
    });
});
```

See [withTags()](../with-tags.md).

## Headroom snapshot

```ts
const snap = openai.budget;
if (snap && snap.remainingUsd < 0.05) {
    // skip the optional rerank
}
```

See [budget snapshot](../budget-snapshot.md).

## Error handling

```ts
import { APIError } from "openai";
import { BudgetExceededError } from "@bursora/sdk";

try {
    await openai.chat.completions.create({ ... });
} catch (err) {
    if (err instanceof BudgetExceededError) {
        // Bursora denied; provider not hit
        return fallback();
    }
    if (err instanceof APIError) {
        // 429 from OpenAI, content filter, etc.
        return retryOrSurface(err);
    }
    throw err;
}
```

See [errors](../errors.md).

## Compatibility

| `openai` package | Status |
| --- | --- |
| ≥ v4 | supported |
| v3.x | not supported (`chat.completions.create` shape differs) |

## Next

- [Anthropic](anthropic.md)
- [DeepSeek](deepseek.md)
- [wrap()](../wrap.md)
