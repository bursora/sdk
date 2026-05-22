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
    /** Map of dotted leaf paths to their replacement function. */
    readonly leaves: ReadonlyMap<string, unknown>;
    /** Root-level lifecycle hooks to graft when absent on target. */
    readonly lifecycle: ProxyLifecycle;
}

export function buildProxy<T extends object>(target: T, opts: BuildProxyOptions): T {
    const tree = buildSubtree(target, opts.leaves, []);
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
        if (child === undefined) continue;
        if (node.leaf !== undefined && node.children.size === 0) {
            out.set(segment, node.leaf);
            continue;
        }
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
