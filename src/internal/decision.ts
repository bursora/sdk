/** Fetches budget decisions with in-process LRU cache. Fail-open on errors. */

import type { Decision, Tags } from "../types";
import { LRUCache } from "./cache";
import { createDefaultLog } from "./default-log";
import { createTransport, serializeError } from "./transport";

/**
 * Pre-call context surfaced to the server so a `block` denial can record the
 * call's intended target on the resulting `usage_events` row. Server treats
 * both fields as optional; sending them lets the dashboard's Blocks tab name
 * the model and provider that were about to run.
 *
 * @public
 */
export interface CallIntent {
    readonly provider: string;
    readonly model: string;
}

/**
 * Resolves a (Tags, CallIntent) pair to a budget decision. The default
 * implementation built by `createDecisionClient` is an in-process LRU cache
 * over `/api/v1/budget`. Customers can supply any object satisfying this
 * shape — e.g. a Redis-backed cache, a sidecar daemon — and pass it through
 * `createBursora({ decision })` to swap the strategy without forking the SDK.
 *
 * @public
 */
export interface DecisionClient {
    /** Returns null when unreachable or non-200; caller proceeds (fail-open). */
    fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null>;
}

/**
 * Construction inputs for the default `DecisionClient` factory. Most callers
 * never see this — they pass `apiKey` + `endpoint` to `createBursora` and let
 * it build the default. Reach for `createDecisionClient` directly when you
 * need to tune `cacheCapacity` or inject a `fetch` implementation.
 *
 * @public
 */
export interface DecisionClientOptions {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly cacheCapacity: number;
    readonly now: () => number;
    readonly fetch?: typeof fetch;
    readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
    readonly decisionTimeoutMs?: number;
}

/**
 * Branded cache key for the decision cache. The brand makes the
 * tenant|agent|workflow join format an explicit type rather than an implicit
 * convention, so a downstream typo (e.g. building a key with a different
 * separator) becomes a compile-time error instead of a silent cache miss.
 */
export type ScopeKey = string & { readonly __scopeKey: unique symbol };

/**
 * Wraps cache values with a format version so a future key-layout bump can
 * ignore stale entries. Bump `SCOPE_KEY_VERSION` whenever the join format,
 * cached payload shape, or any other key-affecting contract changes.
 */
export interface VersionedCacheEntry<T> {
    readonly version: number;
    readonly value: T;
}

/**
 * Current cache-format version. Stays at 1 in shipped code; bumping it
 * implicitly invalidates every long-lived entry in deployed SDKs.
 */
export const SCOPE_KEY_VERSION = 1;

/**
 * Builds the canonical cache key for a (tenant, agent, workflow) scope.
 * Missing fields collapse to "", matching the server-side scope-key shape so
 * undefined vs. empty inputs never split a workspace across cache slots.
 */
export function scopeKey(
    tenantId: string | undefined,
    agentId: string | undefined,
    workflowId: string | undefined,
): ScopeKey {
    return [tenantId ?? "", agentId ?? "", workflowId ?? ""].join("|") as ScopeKey;
}

/**
 * Versioned cache read. Returns `undefined` (and evicts the stored entry)
 * when the entry's version doesn't match `expectedVersion`. This keeps
 * format-evolution safe: a v1 entry left behind by a previous SDK build
 * never poisons a v2 lookup.
 */
export function readVersionedEntry<T, K extends string>(
    cache: LRUCache<VersionedCacheEntry<T>, K>,
    key: K,
    expectedVersion: number,
): T | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.version !== expectedVersion) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

const DECISION_UNAVAILABLE = "bursora_decision_unavailable";
const DEFAULT_DECISION_TIMEOUT_MS = 1500;
/**
 * Cap server-supplied cache TTL. A buggy or hostile server sending huge or
 * negative values would either freeze a stale decision in cache for hours or
 * (via Math.max) get clamped to 0 and thrash the endpoint. One-hour ceiling
 * is long enough that legitimate steady-state TTLs (seconds to minutes) pass
 * through untouched.
 */
const MAX_DECISION_TTL_SECONDS = 3600;

/**
 * Builds the default in-process `DecisionClient`: a versioned LRU cache over
 * `/api/v1/budget` with two-key strategy (scope-only for allow/notify, scope
 * + intent for block). Fail-open on every error path. Exposed as a public
 * factory so customers can construct it independently and pass into
 * `createBursora({ decision })`.
 *
 * @public
 */
export function createDecisionClient(opts: DecisionClientOptions): DecisionClient {
    const cache = new LRUCache<VersionedCacheEntry<Decision>, ScopeKey>({
        capacity: opts.cacheCapacity,
        now: opts.now,
    });
    const transport = createTransport(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
    const log = opts.log ?? createDefaultLog("decision");
    const endpoint = opts.endpoint;
    const timeoutMs = opts.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;

    return {
        async fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null> {
            // Two-key strategy keeps the common allow hit-rate high while
            // closing the block under-enforcement hole. An `allow`/`notify`
            // verdict is a pure function of scope + spend, so cache it at
            // the scope-only key — every later call regardless of model can
            // reuse it. A `block` verdict can depend on the imminent call's
            // model (per-model budgets, or the spend delta of the expensive
            // call is what flips the cap), so cache it at a model-aware key
            // and never let a cheap-model block (or stale scope-only allow)
            // pre-decide an expensive-model call. Reads probe the specific
            // key first, then fall back to scope-only.
            const scopeOnly = scopeKey(tags.tenant_id, tags.agent_id, tags.workflow_id);
            const intentKey = intent !== undefined
                ? `${scopeOnly}|${intent.provider}:${intent.model}` as ScopeKey
                : undefined;
            const cached = (intentKey !== undefined
                ? readVersionedEntry(cache, intentKey, SCOPE_KEY_VERSION)
                : undefined)
                ?? readVersionedEntry(cache, scopeOnly, SCOPE_KEY_VERSION);
            if (cached !== undefined) return cached;

            let url: string;
            try {
                url = buildUrl(endpoint, tags, intent);
            } catch (err) {
                log(DECISION_UNAVAILABLE, {
                    category: "invalid_config",
                    error: serializeError(err),
                });
                return null;
            }
            const result = await transport.send({
                method: "GET",
                url,
                headers: { "x-bursora-key": opts.apiKey },
                timeoutMs,
            });
            if (!result.ok) {
                if (result.timedOut) {
                    log(DECISION_UNAVAILABLE, {
                        category: "network_unavailable",
                        reason: "timeout",
                    });
                } else {
                    log(DECISION_UNAVAILABLE, {
                        category: result.categoryOnFailure,
                        ...(result.status > 0 ? { status: result.status } : {}),
                    });
                }
                return null;
            }
            let raw: unknown;
            try {
                raw = await result.json();
            } catch (err) {
                log(DECISION_UNAVAILABLE, {
                    category: "invalid_response",
                    error: serializeError(err),
                });
                return null;
            }
            const parsed = parseDecision(raw);
            if (parsed === null) {
                log(DECISION_UNAVAILABLE, {
                    category: "invalid_response",
                    error: "schema_mismatch",
                });
                return null;
            }
            const effectiveTtl = Math.max(
                0,
                Math.min(MAX_DECISION_TTL_SECONDS, parsed.ttl_s),
            );
            if (effectiveTtl !== parsed.ttl_s) {
                log(DECISION_UNAVAILABLE, {
                    category: "invalid_response",
                    reason: "ttl_clamped",
                    server_ttl_s: parsed.ttl_s,
                    effective_ttl_s: effectiveTtl,
                });
            }
            if (effectiveTtl > 0) {
                const writeKey = parsed.mode === "block" && intentKey !== undefined
                    ? intentKey
                    : scopeOnly;
                cache.set(
                    writeKey,
                    { version: SCOPE_KEY_VERSION, value: parsed },
                    effectiveTtl,
                );
            }
            return parsed;
        },
    };
}

const VALID_MODES: ReadonlySet<string> = new Set(["notify", "throttle", "block"]);

function parseDecision(raw: unknown): Decision | null {
    if (typeof raw !== "object" || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.allow !== "boolean") return null;
    if (typeof obj.mode !== "string" || !VALID_MODES.has(obj.mode)) return null;
    if (typeof obj.reason !== "string") return null;
    if (typeof obj.ttl_s !== "number" || !Number.isFinite(obj.ttl_s)) return null;
    return {
        allow: obj.allow,
        mode: obj.mode as Decision["mode"],
        reason: obj.reason,
        ttl_s: obj.ttl_s,
        ...(typeof obj.remainingUsd === "number" && Number.isFinite(obj.remainingUsd)
            ? { remainingUsd: obj.remainingUsd }
            : {}),
        ...(typeof obj.resetAt === "string" ? { resetAt: obj.resetAt } : {}),
    };
}

function buildUrl(endpoint: string, tags: Tags, intent?: CallIntent): string {
    const url = new URL("/api/v1/budget", endpoint);
    if (tags.tenant_id !== undefined) url.searchParams.set("tenant", tags.tenant_id);
    if (tags.agent_id !== undefined) url.searchParams.set("agent", tags.agent_id);
    if (tags.workflow_id !== undefined) {
        url.searchParams.set("workflow", tags.workflow_id);
    }
    if (intent !== undefined) {
        url.searchParams.set("provider", intent.provider);
        url.searchParams.set("model", intent.model);
    }
    return url.toString();
}
