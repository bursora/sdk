# Lifecycle

Three lifecycle concerns: when events are sent, how to drain them on shutdown, and what happens when Bursora is down.

## When events are sent

The events client queues calls and ships them in batches. Triggers:

1. **`await client.flush()`** - explicit drain. Sends every queued event in one POST.
2. **`beforeExit`** - the SDK registers one process-wide listener and drains all live clients before Node exits. Long-lived servers rely on this.
3. Future trigger: a periodic flush every N seconds is planned. Today, batching only happens at `flush()` or `beforeExit`.

The queue is in-memory. A hard `process.kill -9` or runtime crash drops the queue. For at-most-once semantics that's fine; for at-least-once, persist your own log alongside.

## Where to flush

| Process type                               | Action                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Long-running server (Express, Next.js dev) | Nothing. `beforeExit` drains on shutdown.                                                           |
| Long-running server with HMR               | Call `client.dispose()` on module replacement so the old client doesn't keep its `beforeExit` slot. |
| AWS Lambda                                 | `await client.flush()` at end of handler.                                                           |
| Cloudflare Workers                         | `await client.flush()` inside `ctx.waitUntil()` so the response returns first.                      |
| Vercel Serverless                          | `await client.flush()` at end of handler.                                                           |
| Vercel Edge                                | `event.waitUntil(client.flush())` pattern.                                                          |
| CLI script                                 | `await client.flush()` before `process.exit()`.                                                     |

## Lambda example

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

export async function handler(event: any) {
    try {
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: event.messages,
        });
        return { ok: true, text: res.choices[0]?.message?.content };
    } finally {
        await openai.flush();
    }
}
```

## Cloudflare Workers example

```ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext) {
        const openai = wrap(new OpenAI({ apiKey: env.OPENAI_API_KEY }), {
            apiKey: env.BURSORA_API_KEY,
            endpoint: env.BURSORA_ENDPOINT,
        });

        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });

        ctx.waitUntil(openai.flush());
        return Response.json({ text: res.choices[0]?.message?.content });
    },
};
```

`waitUntil` keeps the Worker alive long enough for the POST to land, without blocking the response.

## Next.js HMR

The dev server reloads modules. Each reload runs the module body again, building a new wrapped client; the old one stays alive holding a `beforeExit` slot.

Defensive pattern:

```ts
// lib/openai.ts
import OpenAI from "openai";
import { wrap } from "@bursora/sdk";

declare global {
    var __openai: ReturnType<typeof wrap<OpenAI>> | undefined;
}

export const openai =
    globalThis.__openai ??
    (globalThis.__openai = wrap(new OpenAI(), {
        apiKey: process.env.BURSORA_API_KEY!,
        endpoint: process.env.BURSORA_ENDPOINT!,
    }));
```

The `globalThis` cache survives HMR; one wrap, one `beforeExit` slot, no leak.

## `dispose()`

`dispose()` removes the client from the SDK's `beforeExit` drain list.

When to call:

- HMR teardown (the module is going away).
- After your final `flush()` in a short-lived process (let the runtime exit clean).
- Test teardown.

```ts
afterEach(() => {
    openai.dispose();
});
```

`dispose()` does not drain. Call `flush()` first if you have pending events.

## Fail-open

If Bursora is unreachable or slow, the SDK doesn't stand between your app and the provider:

| Path                 | Failure                 | What the SDK does                                                |
| -------------------- | ----------------------- | ---------------------------------------------------------------- |
| Pre-call decision    | Timeout (1.5 s default) | Return `null`; call proceeds                                     |
| Pre-call decision    | Non-2xx status          | Return `null`; call proceeds; log `bursora_decision_unavailable` |
| Pre-call decision    | Malformed JSON          | Return `null`; call proceeds; log                                |
| Post-call event POST | Timeout (5 s default)   | Drop the batch; log `bursora_ingest_unavailable`                 |
| Post-call event POST | Non-2xx status          | Drop the batch; log                                              |
| Setup error POST     | Any                     | Swallow                                                          |

The provider call always either runs or surfaces the provider's own error. Bursora errors never block the path your user is on.

## Decision cache

Decisions are cached in-process for `ttl_s` seconds (server-returned; default 60). Cache key is `(tenant_id, agent_id, workflow_id)`. The cache uses an LRU with 128 slots; busy multi-tenant workloads roll cleanly.

A budget edit hits within the cache window; for `block` budgets near the cap, the server returns a smaller `ttl_s` so denials propagate fast.

## Logs

The default logger writes JSON lines to `stderr` with a `bursora:` prefix:

```
bursora:decision bursora_decision_unavailable {"category":"network_unavailable","reason":"timeout"}
bursora:ingest   bursora_ingest_unavailable   {"category":"http_error","status":503}
```

Inject your own logger via the internal options (advanced; not yet exposed).

## Next

- [Serverless recipe](../recipes/serverless.md) - end-to-end Lambda and Workers patterns.
- [wrap()](wrap.md) - what the lifecycle wraps.
