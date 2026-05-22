# withTags()

Propagate tag context across awaited calls. The wrap reads the current tags at call time, so deeper helpers don't have to thread them.

## Signature

```ts
function withTags<T>(tags: Tags, body: () => Promise<T>): Promise<T>;

function currentTags(): Tags;

interface Tags {
    readonly tenant_id?: string;
    readonly agent_id?: string;
    readonly workflow_id?: string;
}
```

## Basic use

```ts
import { wrap, withTags } from "@bursora/sdk";
import OpenAI from "openai";

const openai = wrap(new OpenAI(), { apiKey, endpoint });

await withTags({ tenant_id: "acme", agent_id: "support-bot" }, async () => {
    await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
    });
});
```

The call lands tagged `tenant_id=acme, agent_id=support-bot` in the dashboard.

## Nested withTags

Nested scopes merge. Parent tags persist; the child wins on key collision:

```ts
await withTags({ tenant_id: "acme" }, async () => {
    // tenant_id=acme
    await withTags({ agent_id: "support-bot" }, async () => {
        // tenant_id=acme, agent_id=support-bot
        await openai.chat.completions.create({ ... });
    });

    await withTags({ tenant_id: "globex" }, async () => {
        // tenant_id=globex (child overrode)
        await openai.chat.completions.create({ ... });
    });
});
```

## How it works

Internally, `withTags` runs the body inside `AsyncLocalStorage.run()`. Every wrapped call inside the scope reads from the same ALS context, so tags survive any `await`, `Promise.all`, or async helper:

```ts
await withTags({ tenant_id: "acme" }, async () => {
    await Promise.all([
        callOne(),  // tagged
        callTwo(),  // tagged
        callThree(), // tagged
    ]);
});
```

ALS is per-call-stack; concurrent requests don't bleed into each other.

## At a request boundary

Set tags once, at the top of your handler:

```ts
// Express
app.post("/api/chat", async (req, res) => {
    await withTags(
        {
            tenant_id: req.user.workspaceId,
            agent_id: req.body.agent ?? "default",
            workflow_id: req.body.workflow,
        },
        async () => handler(req, res),
    );
});
```

```ts
// Next.js route handler
export async function POST(request: Request) {
    const body = await request.json();
    return withTags(
        {
            tenant_id: body.tenant,
            agent_id: "support-bot",
        },
        async () => {
            const res = await openai.chat.completions.create({ ... });
            return Response.json({ reply: res.choices[0]?.message?.content });
        },
    );
}
```

```ts
// Hono
app.post("/chat", async (c) => {
    return withTags(
        { tenant_id: c.req.header("x-tenant") ?? "anon" },
        async () => {
            // ...
        },
    );
});
```

## Reading current tags

```ts
import { currentTags } from "@bursora/sdk";

const tags = currentTags();
// { tenant_id?: string, agent_id?: string, workflow_id?: string }
```

Returns an empty object outside any scope. The returned object is a defensive copy; mutating it does not change the underlying ALS context.

Useful for logging:

```ts
console.log({ ...currentTags(), msg: "calling openai" });
```

## What gets dropped

Bursora only tracks the three tag keys. Extras are silently dropped server-side:

```ts
// only tenant_id and agent_id are kept; "version" is ignored
await withTags(
    { tenant_id: "acme", agent_id: "bot", version: "v2" } as any,
    async () => { ... },
);
```

## High-cardinality tags

The dashboard groups by tag value. Use stable, low-cardinality IDs:

- Good: `"acme"`, `"cust_2KqJ"`, `"support-bot"`, `"nightly-report"`.
- Bad: timestamps, request IDs, UUIDs-per-call, random strings.

A unique tag per call fans out into thousands of one-call rows you can't act on. See [tags](../concepts/tags.md).

## Runtime requirements

`AsyncLocalStorage` is the propagation mechanism:

- Node ≥ 18: built in.
- Bun: built in.
- Cloudflare Workers: requires the `nodejs_compat` flag.
- Vercel Edge: built in.
- Pure-V8 (some legacy edge): not supported.

If ALS isn't available, `withTags` returns the body's result but tags don't propagate.

## Next

- [Tags](../concepts/tags.md) - what the three tags mean.
- [Per-tenant billing](../recipes/per-tenant-billing.md) - patterns built on tags.
