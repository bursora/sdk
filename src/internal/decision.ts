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
 */
export interface CallIntent {
    readonly provider: string;
    readonly model: string;
}

export interface DecisionClient {
    /** Returns null when unreachable or non-200; caller proceeds (fail-open). */
    fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null>;
}

export interface DecisionClientOptions {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly cacheCapacity: number;
    readonly now: () => number;
    readonly fetch?: typeof fetch;
    readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
    readonly decisionTimeoutMs?: number;
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

export function createDecisionClient(opts: DecisionClientOptions): DecisionClient {
    const cache = new LRUCache<Decision>({
        capacity: opts.cacheCapacity,
        now: opts.now,
    });
    const transport = createTransport(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
    const log = opts.log ?? createDefaultLog("decision");
    const endpoint = opts.endpoint;
    const timeoutMs = opts.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;

    return {
        async fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null> {
            // Cache key omits `intent` — decisions are a pure function of
            // scope + spend, not of the imminent call's model. Reusing a
            // cached allow across model changes is correct.
            const key = scopeKey(tags);
            const cached = cache.get(key);
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
                cache.set(key, parsed, effectiveTtl);
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

function scopeKey(tags: Tags): string {
    return [tags.tenant_id ?? "", tags.agent_id ?? "", tags.workflow_id ?? ""].join("|");
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
