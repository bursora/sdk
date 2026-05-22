# Budget snapshot

A read-only headroom snapshot on every wrapped client. Read it between calls to slow down before any block fires.

## Shape

```ts
interface BudgetSnapshot {
    readonly remainingUsd: number; // USD left under tightest applicable budget
    readonly resetAt: string;      // ISO timestamp when that budget resets
}

const snap: BudgetSnapshot | null = openai.budget;
```

`null` until the first decision lands. Once set, later decisions that omit the fields leave the prior snapshot in place; the value never flickers back to `null` mid-process.

## Where it comes from

Every pre-call decision the server returns may include `remainingUsd` and `resetAt`:

```json
{
    "allow": true,
    "mode": "notify",
    "reason": "ok",
    "ttl_s": 60,
    "remainingUsd": 42.18,
    "resetAt": "2026-06-01T00:00:00.000Z"
}
```

The numbers reflect the strictest budget that applies to the current scope. If three budgets all match the call's tags (workspace, tenant, agent), Bursora picks the one with the least headroom.

If no budgets apply, the server omits the fields and `.budget` stays `null` (or keeps its last value).

## Use it to self-degrade

```ts
import { withTags, wrap } from "@bursora/sdk";
import OpenAI from "openai";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

async function reply(tenantId: string, question: string) {
    return withTags({ tenant_id: tenantId }, async () => {
        const snap = openai.budget;
        if (snap && snap.remainingUsd < 0.05) {
            // headroom thin: skip the optional rerank, serve a fallback
            return { degraded: true as const, text: "Quick answer (budget low)." };
        }
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: question }],
        });
        return { degraded: false as const, text: res.choices[0]?.message?.content ?? "" };
    });
}
```

The first call inside a scope still pays a decision lookup; the snapshot is populated after that. Subsequent calls in the same scope (within the 60-second cache window) read the cached snapshot.

## Use it to surface UX

```ts
const snap = openai.budget;
if (snap) {
    const resetIn = new Date(snap.resetAt).getTime() - Date.now();
    const hours = Math.max(0, Math.floor(resetIn / 1000 / 60 / 60));
    console.log(`Budget remaining: $${snap.remainingUsd.toFixed(2)} (resets in ${hours}h)`);
}
```

## Use it to schedule retry after a block

```ts
try {
    await openai.chat.completions.create({ ... });
} catch (err) {
    if (err instanceof BudgetExceededError) {
        const snap = openai.budget;
        if (snap) {
            const retryAt = new Date(snap.resetAt);
            await queue.enqueueAt(retryAt, job);
        }
        return;
    }
    throw err;
}
```

## What it doesn't tell you

- Per-tag breakdowns. Only the tightest budget's headroom.
- Other budgets in scope. If three budgets match, only the strictest is reported.
- A reliable "is the next call going to be blocked" answer. Headroom is a snapshot; concurrent traffic in flight may have moved the number.

For exact "is it blocked" semantics, catch `BudgetExceededError` at the call site.

## Across wrapped clients

Each wrapped client has its own `.budget`. With a shared core, the snapshot still tracks per-wrapped-client; each wrap stores the latest decision it observed. If you wrap both OpenAI and Anthropic, both read the same cached decision under the same tags, but the snapshot on each is the latest one that wrapped client surfaced through its decision call.

## Caveats

- The snapshot updates on decision returns, not on event ingest. After a call lands, the headroom you read still reflects the _last decision_, not the spend you just added.
- During the 60-second decision cache window, the snapshot doesn't tick down with each call.

For real-time accuracy, drop the cache TTL (planned) or query the dashboard.

## Next

- [Self-degrade near cap](../recipes/self-degrade.md) - full recipe with a fallback.
- [Budgets](../concepts/budgets.md) - what "tightest budget" means.
