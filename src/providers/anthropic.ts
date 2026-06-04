/**
 * Anthropic provider manifest consumed by the generic `wrap()` engine.
 *
 * Instrumented methods (each bills by token and reuses the same usage
 * extractor / stream handler):
 *  - `messages.create` — the core Messages call, streaming or not.
 *  - `messages.parse` — structured-output variant of create.
 *  - `messages.stream()` — the convenience streaming helper that returns a
 *    `MessageStream` event emitter (see the tap below).
 *  - `beta.messages.create` / `.parse` / `.stream` — the beta-namespace mirror
 *    power users hit for newer features; identical usage shape.
 *
 * The token-counting endpoint (`messages.countTokens`) is free, and Message
 * Batches report usage only when results are fetched asynchronously, so neither
 * is instrumented here.
 *
 * Anthropic SSE quirks worth knowing:
 *  - `message_start.message.usage.input_tokens` is the prompt count;
 *    output_tokens at that point is always 0.
 *  - `message_delta.usage.output_tokens` is the running CUMULATIVE total,
 *    not an incremental delta. `createAnthropicStreamHandler` tracks
 *    `lastOutputTotal` per stream on an explicit state object so the
 *    engine's sum-of-deltas matches the final cumulative figure.
 *  - `message_stop` marks stream completion; the handler is single-use and
 *    refuses chunks delivered after it.
 */

import { structurallyMatches } from "../internal/detect";
import type {
    EventStreamHooks,
    MethodSpec,
    ProviderManifest,
    UsageDelta,
    UsageTotals,
} from "../types";

const PROVIDER = "anthropic";

interface MessagesArgs {
    readonly model: string;
    readonly stream?: boolean;
}

interface AnthropicUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
    /**
     * TTL breakdown of `cache_creation_input_tokens`. Anthropic has two
     * cache-write rates: 5-minute (1.25x base input) and 1-hour (2x). The merged
     * `cache_creation_input_tokens` can't tell them apart, so the 1-hour slice is
     * reported on its own and priced at 2x server-side.
     */
    readonly cache_creation?: {
        readonly ephemeral_1h_input_tokens?: number;
    };
}

interface MessagesResponse {
    readonly id?: string;
    readonly usage?: AnthropicUsage;
}

interface AnthropicStreamChunk {
    readonly type?: string;
    readonly message?: { readonly id?: string; readonly usage?: AnthropicUsage };
    readonly usage?: AnthropicUsage;
}

export function messagesUsage(response: MessagesResponse): UsageTotals {
    const u = response.usage;
    const cacheWrite = u?.cache_creation_input_tokens ?? 0;
    const cacheWrite1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cache = cacheWrite + (u?.cache_read_input_tokens ?? 0);
    return {
        promptTokens: u?.input_tokens ?? 0,
        completionTokens: u?.output_tokens ?? 0,
        ...(cache > 0 ? { cacheTokens: cache } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        ...(cacheWrite1h > 0 ? { cacheWrite1hTokens: cacheWrite1h } : {}),
        ...(response.id !== undefined ? { requestId: response.id } : {}),
    };
}

// Handler is single-use; one stream per instance. State lives on an explicit
// object so the mutable surface is visible at the call site instead of hidden
// in closure variables. `done` flips on the terminal `message_stop` chunk; any
// later chunk throws so accidental cross-stream reuse fails loudly.
interface AnthropicStreamState {
    lastOutputTotal: number;
    done: boolean;
}

export function createAnthropicStreamHandler(): (chunk: unknown) => UsageDelta | null {
    const state: AnthropicStreamState = { lastOutputTotal: 0, done: false };
    return (raw: unknown) => {
        if (state.done) {
            throw new Error(
                "[bursora] Anthropic stream handler is single-use; create a fresh handler per stream",
            );
        }
        const chunk = raw as AnthropicStreamChunk;
        if (chunk.type === "message_start" && chunk.message?.usage !== undefined) {
            const u = chunk.message.usage;
            const cacheWrite = u.cache_creation_input_tokens ?? 0;
            const cacheWrite1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
            const cache = cacheWrite + (u.cache_read_input_tokens ?? 0);
            return {
                promptTokensDelta: u.input_tokens ?? 0,
                completionTokensDelta: u.output_tokens ?? 0,
                cacheTokensDelta: cache,
                cacheWriteTokensDelta: cacheWrite,
                ...(cacheWrite1h > 0 ? { cacheWrite1hTokensDelta: cacheWrite1h } : {}),
                ...(chunk.message.id !== undefined ? { requestId: chunk.message.id } : {}),
            };
        }
        if (chunk.type === "message_delta" && chunk.usage !== undefined) {
            const total = chunk.usage.output_tokens ?? 0;
            const delta = total - state.lastOutputTotal;
            state.lastOutputTotal = total;
            return {
                promptTokensDelta: 0,
                completionTokensDelta: delta,
                cacheTokensDelta: 0,
            };
        }
        if (chunk.type === "message_stop") {
            state.done = true;
        }
        return null;
    };
}

// `messages.stream()` returns a `MessageStream` EventEmitter that pumps the HTTP
// response to completion on its own and emits a terminal `end` exactly once —
// after every `streamEvent`, and after `error`/`abort` (which each chain into
// `end`). Tapping these four events captures usage for any consumption style
// (iterate, `.on()`, `.finalMessage()`, early break) without replacing the
// object, so the caller keeps the full MessageStream API. `streamEvent` carries
// the same raw chunk shape `createAnthropicStreamHandler` already decodes.
interface MessageStreamLike {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function attachMessageStream(stream: object, hooks: EventStreamHooks): void {
    const s = stream as MessageStreamLike;
    s.on("streamEvent", (event) => hooks.onChunk(event));
    s.on("error", () => hooks.onSettle(true));
    s.on("abort", () => hooks.onSettle(true));
    s.on("end", () => hooks.onSettle(false));
}

const messagesMeta = (args: MessagesArgs): { model: string; isStream: boolean } => ({
    model: args.model,
    isStream: args.stream === true,
});

const messagesCreate: MethodSpec<MessagesArgs, MessagesResponse, AnthropicStreamChunk> = {
    path: ["messages", "create"],
    extractMeta: messagesMeta,
    extractUsage: messagesUsage,
    createStreamHandler: createAnthropicStreamHandler,
};

const messagesParse: MethodSpec<MessagesArgs, MessagesResponse> = {
    path: ["messages", "parse"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: false }),
    extractUsage: messagesUsage,
};

const messagesStream: MethodSpec<MessagesArgs, MessagesResponse, AnthropicStreamChunk> = {
    path: ["messages", "stream"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: true }),
    extractUsage: messagesUsage,
    createStreamHandler: createAnthropicStreamHandler,
    attachEventStream: attachMessageStream,
};

const betaMessagesCreate: MethodSpec<MessagesArgs, MessagesResponse, AnthropicStreamChunk> = {
    path: ["beta", "messages", "create"],
    optional: true,
    extractMeta: messagesMeta,
    extractUsage: messagesUsage,
    createStreamHandler: createAnthropicStreamHandler,
};

const betaMessagesParse: MethodSpec<MessagesArgs, MessagesResponse> = {
    path: ["beta", "messages", "parse"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: false }),
    extractUsage: messagesUsage,
};

const betaMessagesStream: MethodSpec<MessagesArgs, MessagesResponse, AnthropicStreamChunk> = {
    path: ["beta", "messages", "stream"],
    optional: true,
    extractMeta: (args) => ({ model: args.model, isStream: true }),
    extractUsage: messagesUsage,
    createStreamHandler: createAnthropicStreamHandler,
    attachEventStream: attachMessageStream,
};

const anthropicMethods: readonly MethodSpec[] = [
    messagesCreate as MethodSpec,
    messagesParse as MethodSpec,
    messagesStream as MethodSpec,
    betaMessagesCreate as MethodSpec,
    betaMessagesParse as MethodSpec,
    betaMessagesStream as MethodSpec,
];

export const anthropicManifest: ProviderManifest = {
    provider: PROVIDER,
    methods: anthropicMethods,
    detect: structurallyMatches(anthropicMethods),
};
