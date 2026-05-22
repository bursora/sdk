# Shared core

`createBursora()` builds one `BursoraCore` (decision cache + events queue) that several wrapped clients share. A single `flush()` drains every client.

## Signature

```ts
function createBursora(opts: BursoraOptions): BursoraCore;

interface BursoraOptions {
    readonly apiKey: string;
    readonly endpoint: string;
}

interface BursoraCore {
    readonly decision: DecisionLookup;
    readonly events: EventsClient;
    readonly now: () => number;
    flush(): Promise<void>;
    dispose(): void;
}
```

## When to use it

The default `wrap(client, { apiKey, endpoint })` builds a private core per wrapped client. That's fine for one provider.

Reach for `createBursora()` when:

- You wrap both OpenAI and Anthropic (or any combo) and want one `flush()` for both.
- You have a long-lived process and want one decision cache shared across clients (better cache hit rate for the same scope).
- You're in serverless and want to drain everything in one round-trip.

## Example

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

Use them as usual:

```ts
import { withTags } from "@bursora/sdk";

await withTags({ tenant_id: "acme" }, async () => {
    await openai.chat.completions.create({ ... });
    await anthropic.messages.create({ ... });
});
```

On shutdown:

```ts
await core.flush(); // drains BOTH clients' queues in one request
core.dispose();
```

## What's shared, what's not

| Shared                                      | Per wrapped client                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Decision cache (one LRU keyed by tag scope) | The `.budget` snapshot (each wrapped client tracks its own latest decision)                     |
| Events queue (one batch POST)               | The `.flush()` and `.dispose()` exposed on each wrapped client (they delegate to the same core) |

A wrapped client's `.flush()` and `.dispose()` are conveniences. `core.flush()` and `core.dispose()` are the canonical drain.

## Decision cache hit rate

The decision cache is keyed by `(tenant_id, agent_id, workflow_id)`. Same scope across providers means one cache slot. With separate cores, OpenAI and Anthropic each pay a fresh decision lookup per scope.

For a typical request that calls OpenAI first and Anthropic second under the same tags, the shared core saves one round-trip.

## Disposing

`dispose()` removes the core from the SDK's `beforeExit` drain list. Call it on:

- Next.js HMR teardown (the module is being replaced).
- After `flush()` in short-lived serverless handlers (let the host exit cleanly).
- Test teardown (so the leak detector stays quiet).

```ts
beforeEach(() => {
    core = createBursora({ apiKey, endpoint });
});

afterEach(() => {
    core.dispose();
});
```

## What the core exposes

```ts
interface BursoraCore {
    readonly decision: DecisionLookup; // internal: used by wrap()
    readonly events: EventsClient; // internal: used by wrap()
    readonly now: () => number; // internal: time injection for tests
    flush(): Promise<void>; // drain pending events
    dispose(): void; // unregister from beforeExit drain
}
```

`decision`, `events`, and `now` are internal; you almost never touch them directly. Useful for tests (inject a fake `now`, a fake events sink).

## Next

- [wrap()](wrap.md) - the two construction forms.
- [Lifecycle](lifecycle.md) - what `flush()` and `dispose()` actually do.
- [Shared core recipe](../recipes/shared-core.md) - full pattern.
