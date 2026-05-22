# Install

The SDK ships as `@bursora/sdk` on npm. Node ≥ 18, Bun ≥ 1.0. ESM and CJS exports; works in Node, Bun, Deno, Cloudflare Workers, Vercel Edge.

## Install

```bash
npm i @bursora/sdk
# or
bun add @bursora/sdk
# or
pnpm add @bursora/sdk
# or
yarn add @bursora/sdk
```

## Provider clients

Bursora doesn't bundle provider SDKs. Install whichever you call:

```bash
# OpenAI
npm i openai

# Anthropic
npm i @anthropic-ai/sdk

# DeepSeek — reuses the OpenAI client with baseURL override
npm i openai
```

See [providers](providers/openai.md).

## Environment variables

```bash
# .env.local
BURSORA_API_KEY=bsk_47c05e5d-af35-49a3-86a7-eaec1c86a2f1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
BURSORA_ENDPOINT=https://app.bursora.com
```

See [environment variables](../reference/environment.md).

## TypeScript

Types are bundled. No `@types/...` package needed.

```ts
import { wrap, withTags, BudgetExceededError } from "@bursora/sdk";
import type { BursoraOptions, Tags, BudgetSnapshot } from "@bursora/sdk";
```

The SDK targets `target: "es2022"` and `module: "preserve"`. Strict-mode TypeScript projects work without changes.

## Runtimes

| Runtime | Supported | Notes |
| --- | --- | --- |
| Node ≥ 18 | yes | Primary target |
| Bun ≥ 1.0 | yes | Tests run on Bun |
| Deno | yes | Use `npm:@bursora/sdk` |
| Cloudflare Workers | yes | Set `nodejs_compat` flag for `AsyncLocalStorage` |
| Vercel Edge | yes | Same `AsyncLocalStorage` requirement |
| Browser | no | API key in browser = leak |

`withTags` uses Node's `AsyncLocalStorage`. Edge runtimes that polyfill it (Cloudflare with `nodejs_compat`, Vercel Edge) work; pure-V8 runtimes don't.

## Verify the install

```ts
import { wrap } from "@bursora/sdk";
import OpenAI from "openai";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY!,
    endpoint: process.env.BURSORA_ENDPOINT!,
});

console.log("OK", typeof openai.flush); // OK function
```

If `wrap()` throws on init, the provider client shape wasn't recognized; see [errors](errors.md).

## Next

- [wrap()](wrap.md) - what the wrap returns and how it routes calls.
- [Quickstart](../get-started/quickstart.md) - end-to-end in five minutes.
