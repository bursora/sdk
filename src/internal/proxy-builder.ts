/**
 * buildProxy — path-walking nested Proxy constructor.
 *
 * Builds a Proxy tree over `target` that swaps in `leaves` at registered
 * dotted paths and grafts root-level `lifecycle` props when they aren't
 * already owned by the target. Unrelated property reads fall through via
 * `Reflect.get` so the wrapped client behaves identically to the original
 * for everything else.
 *
 * Used by `wrap()` to assemble the per-method instrumentation for any
 * provider manifest without hand-rolling per-provider Proxy chains.
 */

import type { BudgetSnapshot } from "../types";

export interface ProxyLifecycle {
    readonly flush?: () => Promise<void>;
    readonly dispose?: () => void;
    /**
     * Read-only accessor for the snapshot grafted as `target.budget`. The Proxy
     * invokes this on every read, so the value reflects the latest state
     * without subscribers. Returns `null` when no snapshot is available.
     */
    readonly readBudget?: () => BudgetSnapshot | null;
}

export interface BuildProxyOptions {
    /**
     * Dotted leaf paths paired with their replacement function. Accepted as an
     * iterable of tuples (not a Map) so duplicate paths surface as errors
     * instead of being silently coalesced by Map's key dedup.
     */
    readonly leaves: Iterable<readonly [string, unknown]>;
    /** Root-level lifecycle hooks to graft when absent on target. */
    readonly lifecycle: ProxyLifecycle;
}

export function buildProxy<T extends object>(target: T, opts: BuildProxyOptions): T {
    const leaves = collectLeaves(opts.leaves);
    const tree = buildSubtree(target, leaves, []);
    return new Proxy(target, {
        get(t, prop, receiver) {
            if (typeof prop === "string") {
                const lifecycle = lifecycleFor(t, prop, opts.lifecycle);
                if (lifecycle !== undefined) return lifecycle;
                const sub = tree.get(prop);
                if (sub !== undefined) return sub;
            }
            return Reflect.get(t, prop, receiver);
        },
    });
}

// Materialize the leaves iterable into a Map and surface duplicate paths as
// an error instead of silently letting the later entry win. A typo in a
// provider manifest that points two MethodSpecs at the same path would
// otherwise no-op one of them with no signal.
function collectLeaves(
    entries: Iterable<readonly [string, unknown]>,
): ReadonlyMap<string, unknown> {
    const seen = new Set<string>();
    const out = new Map<string, unknown>();
    for (const [path, fn] of entries) {
        if (seen.has(path)) {
            throw new Error(`buildProxy: duplicate method path '${path}' in manifest`);
        }
        seen.add(path);
        out.set(path, fn);
    }
    return out;
}

interface SubtreeNode {
    readonly leaf?: unknown;
    readonly children: Map<string, SubtreeNode>;
}

// Build a per-segment map: first segment → SubtreeNode describing what
// happens beneath. Skip paths whose intermediate segment is missing on the
// target so optional client surfaces (e.g. `responses` on OpenAI v4) don't
// surface as proxies that return undefined.
function buildSubtree(
    target: unknown,
    leaves: ReadonlyMap<string, unknown>,
    prefix: readonly string[],
): Map<string, unknown> {
    const nodes = collectNodes(leaves, prefix);
    const out = new Map<string, unknown>();
    for (const [segment, node] of nodes) {
        const child = readChild(target, segment);
        if (node.leaf !== undefined && node.children.size === 0) {
            // Pure leaf at this segment. Install only when present on the
            // target; missing leaves keep the skip-silently behavior so the
            // proxy doesn't shadow absent client surfaces.
            if (child !== undefined) out.set(segment, node.leaf);
            continue;
        }
        if (child === undefined) continue;
        const nestedTarget = child as object;
        const nested = buildSubtree(nestedTarget, leaves, [...prefix, segment]);
        out.set(segment, wrapSegmentProxy(nestedTarget, nested));
    }
    return out;
}

function collectNodes(
    leaves: ReadonlyMap<string, unknown>,
    prefix: readonly string[],
): Map<string, SubtreeNode> {
    const out = new Map<string, SubtreeNode>();
    for (const [path, fn] of leaves) {
        const parts = path.split(".");
        if (!startsWith(parts, prefix)) continue;
        const rest = parts.slice(prefix.length);
        if (rest.length === 0) continue;
        const head = rest[0];
        if (head === undefined) continue;
        const existing = out.get(head) ?? { children: new Map() };
        if (rest.length === 1) {
            out.set(head, { leaf: fn, children: existing.children });
        } else {
            existing.children.set(rest.slice(1).join("."), { children: new Map() });
            out.set(head, existing);
        }
    }
    return out;
}

function startsWith(parts: readonly string[], prefix: readonly string[]): boolean {
    if (parts.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i += 1) {
        if (parts[i] !== prefix[i]) return false;
    }
    return true;
}

function readChild(target: unknown, segment: string): unknown {
    if (typeof target !== "object" || target === null) return undefined;
    const value = (target as Record<string, unknown>)[segment];
    if (value === undefined) return undefined;
    return value;
}

// Inner Proxy: handles a non-root segment. No lifecycle grafting here —
// only at root. Property reads fall through to the original via Reflect.
function wrapSegmentProxy(target: object, overrides: ReadonlyMap<string, unknown>): unknown {
    return new Proxy(target, {
        get(t, prop, receiver) {
            if (typeof prop === "string") {
                const sub = overrides.get(prop);
                if (sub !== undefined) return sub;
            }
            return Reflect.get(t, prop, receiver);
        },
    });
}

function lifecycleFor(target: object, prop: string, lifecycle: ProxyLifecycle): unknown {
    if (prop === "flush") {
        if (prop in target) return undefined;
        const flush = lifecycle.flush;
        return flush === undefined ? undefined : flush;
    }
    if (prop === "dispose") {
        if (prop in target) return undefined;
        const dispose = lifecycle.dispose;
        return dispose === undefined ? undefined : dispose;
    }
    if (prop === "budget") {
        if (prop in target) return undefined;
        const readBudget = lifecycle.readBudget;
        return readBudget === undefined ? undefined : readBudget();
    }
    return undefined;
}
