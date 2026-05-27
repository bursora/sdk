/**
 * Generic provider wrapper. `wrap(client, optsOrCore)` finds the first
 * registered manifest whose `detect(client)` returns true and returns a
 * Proxy that routes each instrumented method through the standard call
 * lifecycle (decision lookup, event emission, stream handling, error path).
 *
 * The second argument is either `{ apiKey, endpoint }` (the SDK constructs
 * a private `BursoraCore` for this wrapped client) or a pre-built `BursoraCore`
 * (advanced: share one decision cache + events queue across multiple wrapped
 * clients).
 *
 * Detection is owned by each provider file (see `internal/detect.ts` for the
 * composable primitives). No `instanceof`, no runtime dep on `openai` or
 * `@anthropic-ai/sdk` — the wrap engine just iterates manifests and asks.
 */

import { type BursoraOptions, createBursora } from "./bursora";
import type { CallIntent } from "./internal/decision";
import { type EventsClient, safeFlush } from "./internal/events";
import { type MethodHolder, resolvePath } from "./internal/path-resolver";
import { buildProxy } from "./internal/proxy-builder";
import { type DecisionLookup, wrapCall } from "./internal/wrap-call";
import { anthropicManifest } from "./providers/anthropic";
import { deepseekAnthropicManifest, deepseekOpenaiManifest } from "./providers/deepseek";
import { openaiManifest } from "./providers/openai";
import type { BudgetSnapshot, Decision, MethodSpec, ProviderManifest, Tags } from "./types";

export type { EventsClient, SetupErrorInput, SetupErrorKind } from "./internal/events";
export type { DecisionLookup, StreamChunkHandler } from "./internal/wrap-call";
export type { BudgetSnapshot, UsageDelta } from "./types";

export interface BursoraCore {
    readonly decision: DecisionLookup;
    readonly events: EventsClient;
    readonly now: () => number;
    flush(): Promise<void>;
    dispose(): void;
}

export type Wrapped<T> = T & {
    readonly flush: () => Promise<void>;
    readonly dispose: () => void;
    readonly budget: BudgetSnapshot | null;
};

// Order is load-bearing: DeepSeek manifests gate on `baseURL` and must be
// tried before the plain shape-only OpenAI / Anthropic manifests, otherwise
// a DeepSeek-flavored client would short-circuit on the plain manifest and
// emit events tagged with the wrong provider. Pinned by `wrap-detect.test.ts`.
const MANIFESTS: readonly ProviderManifest[] = [
    deepseekOpenaiManifest,
    deepseekAnthropicManifest,
    openaiManifest,
    anthropicManifest,
];

export function wrap<T extends object>(
    client: T,
    optsOrCore: BursoraCore | BursoraOptions,
): Wrapped<T> {
    const core = "apiKey" in optsOrCore ? createBursora(optsOrCore) : optsOrCore;
    const manifest = MANIFESTS.find((m) => m.detect(client)) ?? null;
    if (manifest === null) {
        // Guard with `typeof === 'function'` rather than `?.` so a custom
        // EventsClient that exposes a non-callable `recordSetupError`
        // (structural typing lets that slip past) can't mask the real
        // detection error with a `TypeError: not a function`.
        if (typeof core.events.recordSetupError === "function") {
            core.events.recordSetupError({ kind: "sdk_unknown_provider" });
        }
        throw new Error(
            "[bursora] wrap: unable to detect provider; expected an OpenAI, Anthropic, or DeepSeek-shaped client",
        );
    }

    let latestSnapshot: BudgetSnapshot | null = null;
    // Track the previously returned Decision by reference. The underlying
    // `LRUCache` hands back the same Entry value on cache hits, so identity
    // equality is a faithful "fresh fetch vs cache hit" signal: writing
    // `latestSnapshot` on every lookup would rewrite the same headroom data
    // and let consumers observe a phantom update mid-process.
    let lastDecision: Decision | null = null;
    const snapshotTap: DecisionLookup = {
        async fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null> {
            const decision = await core.decision.fetchDecision(tags, intent);
            if (decision !== null && decision !== lastDecision) {
                const next = toBudgetSnapshot(decision);
                if (next !== null) latestSnapshot = next;
                lastDecision = decision;
            }
            return decision;
        },
    };

    // Use an array (not a Map) so duplicate paths in the manifest reach
    // buildProxy intact — buildProxy throws on collision instead of letting
    // Map's key dedup silently drop one of the wrappers.
    const leaves: [string, unknown][] = [];
    for (const spec of manifest.methods) {
        const target = resolvePath(client, spec.path);
        if (target === undefined) {
            if (spec.optional === true) continue;
            throw new Error(
                `[bursora] wrap(${manifest.provider}): missing required path '${spec.path.join(".")}'`,
            );
        }
        leaves.push([
            spec.path.join("."),
            wrapMethod(target, spec, manifest.provider, core, snapshotTap),
        ]);
    }

    return buildProxy(client, {
        leaves,
        lifecycle: {
            flush: () => safeFlush(core.events),
            dispose: () => core.events.dispose?.(),
            readBudget: () => latestSnapshot,
        },
    }) as Wrapped<T>;
}

function toBudgetSnapshot(decision: Decision): BudgetSnapshot | null {
    if (typeof decision.remainingUsd !== "number") return null;
    if (typeof decision.resetAt !== "string" || decision.resetAt === "") return null;
    return { remainingUsd: decision.remainingUsd, resetAt: decision.resetAt };
}

function wrapMethod(
    holder: MethodHolder,
    spec: MethodSpec,
    provider: string,
    core: BursoraCore,
    decisionLookup: DecisionLookup,
): (args: unknown) => Promise<unknown> {
    return wrapCall<unknown, unknown>((args) => holder.fn.call(holder.thisArg, args), {
        decisionClient: decisionLookup,
        eventsClient: core.events,
        now: core.now,
        extractCallMeta: (args) => {
            const meta = spec.extractMeta(args);
            return { provider, model: meta.model, isStream: meta.isStream };
        },
        extractUsage: (res) => spec.extractUsage(res),
        ...(spec.createStreamHandler === undefined
            ? {}
            : { createStreamHandler: spec.createStreamHandler }),
    });
}
