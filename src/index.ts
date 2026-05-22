/**
 * @bursora/sdk public surface.
 *
 *   - `wrap(client, { apiKey, endpoint })` — auto-detects OpenAI, Anthropic,
 *     or DeepSeek client by shape (DeepSeek via `baseURL` inspection), returns
 *     a Proxy that flows every instrumented method through the Bursora
 *     decision/event lifecycle. The SDK builds a private `BursoraCore` for this
 *     wrapped client.
 *   - `wrap(client, core)` — advanced. Pass a pre-built `BursoraCore` to share
 *     one decision cache + events queue across multiple wrapped clients.
 *   - `createBursora(opts)` — builds a shared `BursoraCore` (decision cache +
 *     events queue + flush + dispose). Only needed for the shared-core case.
 *   - `withTags(tags, fn)` — propagates tag context across awaited calls.
 *   - `BudgetExceededError` — thrown when a block-mode budget rejects a call.
 */

export { createBursora } from "./bursora";
export { BudgetExceededError } from "./errors";
export { currentTags, withTags } from "./tags";
export { wrap } from "./wrap";

export type { BursoraOptions } from "./bursora";
export type { BudgetMode, Decision, Tags, Usage, UsageDelta } from "./types";
export type { BudgetSnapshot, BursoraCore, Wrapped } from "./wrap";
