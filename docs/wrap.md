# wrap()

`wrap(client, opts)` returns a Proxy that routes every instrumented method through the Bursora decision lifecycle.

## Signature

```ts
function wrap<T extends object>(
    client: T,
    optsOrCore: BursoraOptions | BursoraCore,
): Wrapped<T>;

interface BursoraOptions {
    readonly apiKey: string;
    readonly endpoint: string;
}

type Wrapped<T> = T & {
    readonly flush: () => Promise<void>;
    readonly dispose: () => void;
    readonly budget: BudgetSnapshot | null;
};
```

## Basic use

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
});
```

The returned object is structurally identical to the input client; existing call sites keep compiling. Three extras get added:

| Property | What it does |
| --- | --- |
| `.flush()` | Drain queued usage events. Returns a Promise that resolves when the in-flight POST completes (or fails). |
| `.dispose()` | Unregister from the shared `beforeExit` drain. Call on HMR teardown or after `.flush()` in short-lived processes. |
| `.budget` | Read-only headroom snapshot from the most recent decision. `null` until the first decision lands. |

## Provider detection

Wrap inspects the client's shape to pick a manifest:

| Client shape | Detected as |
| --- | --- |
| OpenAI client with `chat.completions.create`, `embeddings.create`, etc. | `openai` |
| Anthropic client with `messages.create` | `anthropic` |
| OpenAI client with `baseURL` containing `"deepseek"` | `deepseek` (OpenAI shape) |
| Anthropic client with `baseURL` containing `"deepseek"` | `deepseek` (Anthropic compat shape) |

Detection order: DeepSeek variants first, then plain OpenAI and Anthropic. A DeepSeek-flavored client always wins over the plain shape.

If no manifest matches, `wrap()` throws:

```
[bursora] wrap: unable to detect provider; expected an OpenAI, Anthropic, or DeepSeek-shaped client
```

A setup error is also POSTed to the dashboard so the admin sees the misconfiguration.

## What gets instrumented

Per provider:

| Provider | Methods |
| --- | --- |
| OpenAI | `chat.completions.create`, `responses.create`, `embeddings.create`, `beta.chat.completions.parse` |
| Anthropic | `messages.create` |
| DeepSeek (OpenAI shape) | same as OpenAI |
| DeepSeek (Anthropic shape) | same as Anthropic |

Anything else on the client passes through untouched.

See [providers](providers/openai.md) for per-provider details.

## Two construction forms

### Private core (default)

```ts
const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});
```

A `BursoraCore` (decision cache + events queue) is built for this wrapped client. `.flush()` drains only this client's queue.

### Shared core

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createBursora, wrap } from "@bursora/sdk";

const core = createBursora({ apiKey, endpoint });
const openai = wrap(new OpenAI(), core);
const anthropic = wrap(new Anthropic(), core);

// later
await core.flush(); // drains BOTH clients in one request
core.dispose();
```

Use the shared form when you have multiple wrapped clients and want one `flush()` to drain them all. See [shared core](shared-core.md).

## Streams

Streaming calls pass through unchanged. The SDK reads token counts from the final chunk (OpenAI) or from `message_start.usage` + `message_delta.usage` events (Anthropic).

```ts
const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    stream_options: { include_usage: true }, // required for OpenAI streams
    messages: [{ role: "user", content: "hi" }],
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Without `stream_options.include_usage: true`, OpenAI streams record zero tokens. Anthropic streams emit usage automatically.

## Errors

A `block`-mode budget denying the call throws before the provider call:

```ts
import { BudgetExceededError } from "@bursora/sdk";

try {
    await openai.chat.completions.create({ ... });
} catch (err) {
    if (err instanceof BudgetExceededError) {
        // err.mode, err.reason, err.tag
    } else {
        throw err;
    }
}
```

Provider errors (rate limits, validation errors, etc.) bubble up untouched.

See [errors](errors.md).

## Fail-open

If Bursora is unreachable, slow, or returns garbage, the decision lookup returns `null` and the call proceeds. Token tracking misses that call; enforcement doesn't block traffic.

Configurable timeouts (planned):

- Decision lookup: 1.5 s default.
- Event ingest: 5 s default.

## Where to wrap

Wrap at module load, once per client:

```ts
// lib/openai.ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

export const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});
```

```ts
// somewhere else
import { openai } from "@/lib/openai";

await openai.chat.completions.create({ ... });
```

Don't wrap per-request; you'd burn through cache slots and lose the decision cache.

## Next

- [withTags()](with-tags.md) - tag the calls.
- [Budget snapshot](budget-snapshot.md) - read `.budget` between calls.
- [Lifecycle](lifecycle.md) - flush, dispose, fail-open.
