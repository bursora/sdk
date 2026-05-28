# Errors

The SDK throws one custom error: `BudgetExceededError`. Everything else bubbles up untouched (provider errors, validation errors, network errors).

## BudgetExceededError

Thrown by the wrap _before_ the provider call when the server returns `{ allow: false, mode: "block" }`. The provider is never hit; no charge lands.

### Shape

```ts
class BudgetExceededError extends Error {
    readonly name: "BudgetExceededError";
    readonly message: string; // "Budget exceeded: <reason>"
    readonly tag: Tags; // scope that tripped
    readonly reason: string; // server-supplied machine code
    readonly mode: "block" | "throttle" | "notify"; // always "block" for thrown errors
}

interface Tags {
    readonly tenant_id?: string;
    readonly agent_id?: string;
    readonly workflow_id?: string;
}
```

### Catching it

```ts
import { BudgetExceededError } from "@bursora/sdk";

try {
    await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
    });
} catch (err) {
    if (err instanceof BudgetExceededError) {
        // budget hit; downgrade or surface the error
        console.log(err.tag); // { tenant_id: "acme" }
        console.log(err.reason); // "budget_exceeded:tenant_id:acme:monthly:50.00"
        console.log(err.mode); // "block"
        return fallback();
    }
    throw err;
}
```

### Surfacing it in HTTP

```ts
app.post("/api/chat", async (req, res) => {
    try {
        await withTags({ tenant_id: req.user.id }, async () => {
            const r = await openai.chat.completions.create({ ... });
            res.json({ text: r.choices[0]?.message?.content });
        });
    } catch (err) {
        if (err instanceof BudgetExceededError) {
            return res.status(429).json({
                error: "budget_exceeded",
                reason: err.reason,
                tag: err.tag,
            });
        }
        throw err;
    }
});
```

`429 Too Many Requests` is the canonical status for "your call would have gone over the cap." Some teams prefer `402 Payment Required` for per-tenant caps that map to plan limits.

### Reading the reason

`reason` is a machine-parseable string:

```
budget_exceeded:<scope_key>:<value>:<period>:<cap_usd>
```

Examples:

- `budget_exceeded:workspace::monthly:5000.00`
- `budget_exceeded:tenant_id:acme:monthly:50.00`
- `budget_exceeded:agent_id:summarizer:daily:10.00`

Use `err.tag` for the structured scope; use `err.reason` for log lines.

## Init errors

`wrap()` can throw at construction time.

### Unknown provider

```
Error: [bursora] wrap: unable to detect provider; expected an OpenAI,
Anthropic, or DeepSeek-shaped client
```

Cause: you passed something that doesn't match any provider manifest (a different SDK, a bare object, a wrong import).

Fix: confirm the import is the official `openai` or `@anthropic-ai/sdk` package, or a DeepSeek-flavored client built with `new OpenAI({ baseURL: "https://api.deepseek.com" })`.

A setup-error POST also lands on the dashboard so the workspace admin sees the misconfiguration.

### Missing options

```
Error: createBursora: apiKey is required
Error: createBursora: endpoint is required
```

Cause: empty string passed for `apiKey` or `endpoint`. Most often `process.env.BURSORA_API_KEY` resolves to `undefined` and `!` coerces to `""`.

Fix: confirm the env var is set; check your secret manager.

### Invalid endpoint URL

The events client builds `new URL("/api/v1/events", endpoint)` at construction. A malformed `endpoint` won't throw at `wrap()` time, but every flush will log:

```
bursora:ingest bursora_ingest_unavailable {"category":"invalid_config","error":"..."}
```

Fix: `endpoint` must be a full origin: `https://app.bursora.com`. No path, no trailing slash needed.

## Init warnings (not thrown)

### Missing required method

```
[bursora-sdk] missing required method chat.completions.create; using no-op fallback
```

Cause: the wrapped client is missing a method the manifest expects (a version mismatch on the provider SDK, or a custom shape). `wrap()` returns successfully and substitutes a no-op so callers don't crash; calling the missing method returns `undefined`.

Fix: upgrade the provider SDK (e.g. `openai` ≥ v4) so the expected method is present. The no-op fallback is a deprecation window — a future minor release replaces it with a hard throw.

## HTTP errors (not thrown)

The SDK swallows transport errors on both the decision and event paths. They don't bubble up to your code; they go to the logger.

### Decision unavailable

```
bursora:decision bursora_decision_unavailable {"category":"network_unavailable","reason":"timeout"}
bursora:decision bursora_decision_unavailable {"category":"http_error","status":503}
bursora:decision bursora_decision_unavailable {"category":"invalid_response","error":"schema_mismatch"}
```

Effect: the call proceeds (fail-open). Token tracking misses that call; enforcement does not block traffic.

### Ingest unavailable

```
bursora:ingest bursora_ingest_unavailable {"category":"network_unavailable","reason":"timeout"}
bursora:ingest bursora_ingest_unavailable {"category":"http_error","status":401}
```

Effect: the batch is dropped. Most common cause: bad API key (`401`) or unreachable endpoint.

A `401` from ingest is the dashboard's hint that the SDK is wired up but the key is wrong; the workspace admin sees an "auth failure" setup error on the dashboard status strip.

## Provider errors

Anything the provider throws bubbles through unchanged:

```ts
import { APIError } from "openai";

try {
    await openai.chat.completions.create({ ... });
} catch (err) {
    if (err instanceof APIError) {
        // 429, 500, content filter, model not found, etc.
        console.log(err.status, err.message);
    }
    if (err instanceof BudgetExceededError) {
        // Bursora denied before the provider was hit
    }
    throw err;
}
```

Bursora records errored calls too. The event includes `errored: true` so the dashboard can split successful tokens from failed-call tokens (provider charges for some failures).

## Next

- [Reference: error catalog](../reference/errors.md) - the full code table.
- [Budgets](../concepts/budgets.md) - what triggers `BudgetExceededError`.
- [Lifecycle](lifecycle.md) - what fail-open means in practice.
