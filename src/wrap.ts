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
import type { EventsClient } from "./internal/events";
import { type MethodHolder, resolvePath } from "./internal/path-resolver";
import { providerFromBaseURL } from "./internal/provider-from-base-url";
import { buildProxy } from "./internal/proxy-builder";
import { type DecisionLookup, wrapCall, wrapEventStreamCall } from "./internal/wrap-call";
import { anthropicManifest } from "./providers/anthropic";
import { googleManifest } from "./providers/google";
import { openaiManifest } from "./providers/openai";
import type {
    BudgetSnapshot,
    Decision,
    FactoryMethodSpec,
    FactorySpec,
    MethodSpec,
    ProviderManifest,
    Tags,
} from "./types";

/** @internal SDK internals; not part of the stable public API. */
export type { EventsClient } from "./internal/events";
/** @internal SDK internals; not part of the stable public API. */
export type { DecisionLookup } from "./internal/wrap-call";
export type { BudgetSnapshot, UsageDelta } from "./types";

export interface BursoraCore {
    readonly decision: DecisionLookup;
    readonly events: EventsClient;
    readonly now: () => number;
    flush(): Promise<void>;
    dispose(): void;
}

export type Wrapped<T> = T & {
    readonly budget: BudgetSnapshot | null;
};

// Order governs the shape tie-break only: a hybrid client matching more than
// one shape is claimed by whichever manifest comes first. The Google native
// shape (`models.generateContent`) is disjoint from the OpenAI and Anthropic
// shapes, so it never competes. Provider labeling is independent — the slug is
// resolved per call from the client's `baseURL` (see `providerFromBaseURL`), so
// manifest order no longer affects which provider an event carries. Pinned by
// `wrap-detect.test.ts`.
const MANIFESTS: readonly ProviderManifest[] = [openaiManifest, anthropicManifest, googleManifest];

export function wrap<T extends object>(
    client: T,
    optsOrCore: BursoraCore | BursoraOptions,
): Wrapped<T> {
    // `now` is on every BursoraCore and never on BursoraOptions (which uses
    // `clock`), so its presence distinguishes the two even when `apiKey` and
    // `endpoint` are absent (the custom-adapters path).
    const core = "now" in optsOrCore ? optsOrCore : createBursora(optsOrCore);
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
            "[bursora] wrap: unable to detect provider; expected an OpenAI, Anthropic, or Google (Gemini)-shaped client",
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
        // A missing path here is always an optional one: `detect` is
        // `structurallyMatches` over this same method list, so every required
        // path is guaranteed present or the manifest never matched.
        if (target === undefined) continue;
        leaves.push([
            spec.path.join("."),
            wrapMethod(target, spec, client, manifest, core, snapshotTap),
        ]);
    }

    // Factory methods (e.g. `chats.create`) return a stateful object the flat
    // path list can't reach. Install a leaf at the factory path that wraps the
    // returned object's methods with the model captured from the factory call.
    for (const factory of manifest.factories ?? []) {
        const target = resolvePath(client, factory.path);
        if (target === undefined) continue;
        leaves.push([
            factory.path.join("."),
            wrapFactory(target, factory, client, manifest, core, snapshotTap),
        ]);
    }

    return buildProxy(client, {
        leaves,
        lifecycle: {
            readBudget: () => latestSnapshot,
        },
    }) as Wrapped<T>;
}

function toBudgetSnapshot(decision: Decision): BudgetSnapshot | null {
    if (typeof decision.remainingUsd !== "number") return null;
    if (typeof decision.resetAt !== "string" || decision.resetAt === "") return null;
    return { remainingUsd: decision.remainingUsd, resetAt: decision.resetAt };
}

// Resolve the provider slug + region stamped on every event for this client.
// A manifest's `resolveLabels` hook (e.g. Google's Vertex detection) takes
// precedence; otherwise the slug comes from the client's `baseURL` and there
// is no region. Labels derive from the client instance, not call args, so the
// result is constant for the wrapped client's lifetime.
function clientLabels(
    manifest: ProviderManifest,
    client: object,
): { provider: string; region?: string } {
    const labels = manifest.resolveLabels?.(client) ?? {};
    return {
        provider: labels.provider ?? providerFromBaseURL(client, manifest.provider),
        ...(labels.region === undefined ? {} : { region: labels.region }),
    };
}

function wrapMethod(
    holder: MethodHolder,
    spec: MethodSpec,
    client: object,
    manifest: ProviderManifest,
    core: BursoraCore,
    decisionLookup: DecisionLookup,
): (args: unknown) => unknown {
    const labels = clientLabels(manifest, client);
    const extractCallMeta = (args: unknown) => {
        const meta = spec.extractMeta(args);
        return {
            provider: labels.provider,
            model: meta.model,
            isStream: meta.isStream,
            ...(labels.region === undefined ? {} : { region: labels.region }),
        };
    };

    // Sync-returning event-emitter streams (Anthropic `messages.stream()`) can't
    // go through the async `wrapCall`: awaiting would turn the synchronous
    // return into a Promise and strip the stream's `.on()` / `.finalMessage()`
    // surface. Tap its events and hand the original object back instead.
    if (spec.attachEventStream !== undefined) {
        return wrapEventStreamCall<unknown, unknown>(
            (args) => holder.fn.call(holder.thisArg, args),
            {
                eventsClient: core.events,
                now: core.now,
                extractCallMeta,
                attachEventStream: spec.attachEventStream,
                ...(spec.createStreamHandler === undefined
                    ? {}
                    : { createStreamHandler: spec.createStreamHandler }),
            },
        );
    }

    return wrapCall<unknown, unknown>((args) => holder.fn.call(holder.thisArg, args), {
        decisionClient: decisionLookup,
        eventsClient: core.events,
        now: core.now,
        extractCallMeta,
        extractUsage: (res) => spec.extractUsage(res),
        ...(spec.createStreamHandler === undefined
            ? {}
            : { createStreamHandler: spec.createStreamHandler }),
    });
}

// `chats.create` is synchronous: it returns the stateful `Chat` immediately.
// Call it, capture the model bound at create time, then proxy the returned
// object so its instrumented methods route through the lifecycle. Unlisted
// methods (history, etc.) fall through to the original via buildProxy.
function wrapFactory(
    holder: MethodHolder,
    factory: FactorySpec,
    client: object,
    manifest: ProviderManifest,
    core: BursoraCore,
    decisionLookup: DecisionLookup,
): (args: unknown) => unknown {
    return (args: unknown) => {
        const created = holder.fn.call(holder.thisArg, args) as object;
        const model = factory.extractModel(args);
        const leaves: [string, unknown][] = [];
        for (const fm of factory.methods) {
            const method = (created as Record<string, unknown>)[fm.name];
            if (typeof method !== "function") continue;
            leaves.push([
                fm.name,
                wrapFactoryMethod(
                    method as (a: unknown) => Promise<unknown>,
                    created,
                    fm,
                    model,
                    client,
                    manifest,
                    core,
                    decisionLookup,
                ),
            ]);
        }
        return buildProxy(created, { leaves, lifecycle: {} });
    };
}

function wrapFactoryMethod(
    fn: (args: unknown) => Promise<unknown>,
    thisArg: object,
    spec: FactoryMethodSpec,
    model: string,
    client: object,
    manifest: ProviderManifest,
    core: BursoraCore,
    decisionLookup: DecisionLookup,
): (args: unknown) => Promise<unknown> {
    const labels = clientLabels(manifest, client);
    return wrapCall<unknown, unknown>((args) => fn.call(thisArg, args), {
        decisionClient: decisionLookup,
        eventsClient: core.events,
        now: core.now,
        // Model is bound at factory time, so the per-call args are ignored here.
        extractCallMeta: () => ({
            provider: labels.provider,
            model,
            isStream: spec.isStream,
            ...(labels.region === undefined ? {} : { region: labels.region }),
        }),
        extractUsage: (res) => spec.extractUsage(res),
        ...(spec.createStreamHandler === undefined
            ? {}
            : { createStreamHandler: spec.createStreamHandler }),
    });
}
