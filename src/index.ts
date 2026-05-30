/**
 * @bursora/sdk public surface.
 *
 *   - `wrap(client, { apiKey, endpoint })` — auto-detects an OpenAI,
 *     Anthropic, or Google (Gemini) client by shape, returns a Proxy that flows every instrumented
 *     method through the Bursora decision/event lifecycle. The provider slug
 *     for each event is resolved from the client's `baseURL`, so any
 *     OpenAI-compatible vendor (DeepSeek, Groq, xAI, ...) meters correctly. The
 *     SDK builds a private `BursoraCore` for this wrapped client.
 *   - `wrap(client, core)` — advanced. Pass a pre-built `BursoraCore` to share
 *     one decision cache + events queue across multiple wrapped clients.
 *   - `createBursora(opts)` — builds a shared `BursoraCore` (decision cache +
 *     events queue + flush + dispose). Pass `decision` and/or `events` to plug
 *     in a custom adapter; pass nothing extra to get the built-in defaults.
 *   - `createDecisionClient(opts)` / `createEventsQueue(opts)` — public
 *     factories for the default adapters. Construct them independently and
 *     hand them to `createBursora` to mix-and-match (e.g. custom cache +
 *     default queue).
 *   - `withTags(tags, fn)` — propagates tag context across awaited calls.
 *   - `bursoraMiddleware(opts)` — for apps on the Vercel AI SDK (`ai`). Returns
 *     a middleware for `wrapLanguageModel({ model, middleware })` that gates and
 *     meters `generateText`/`streamText` calls. `ai` is an optional peer dep.
 *   - `BudgetExceededError` — thrown when a block-mode budget rejects a call.
 */

/** @public */
export { bursoraMiddleware } from "./ai-sdk";
/** @public */
export { createBursora } from "./bursora";
/** @public */
export { BudgetExceededError } from "./errors";
/** @public */
export { createDecisionClient } from "./internal/decision";
/** @public */
export { createEventsQueue } from "./internal/events";
/** @internal SDK internals; not part of the stable public API. */
export { currentTags } from "./tags";
/** @public */
export { withTags } from "./tags";
/** @public */
export { wrap } from "./wrap";

export type { BursoraOptions } from "./bursora";
/** @public */
export type { CallIntent, DecisionClient, DecisionClientOptions } from "./internal/decision";
/** @public */
export type { EventInput, EventsClientOptions, EventsQueue } from "./internal/events";
export type { BudgetMode, Decision, Tags, Usage, UsageDelta } from "./types";
export type { BudgetSnapshot } from "./wrap";
/** @internal SDK internals; not part of the stable public API. */
export type { BursoraCore, Wrapped } from "./wrap";
