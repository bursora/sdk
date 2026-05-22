/**
 * Shared helper for walking a dotted method path on a client object.
 * Used by both `wrap()` (to wire proxy leaves) and provider detect
 * predicates (to ask "does this path resolve to a function?").
 */

export interface MethodHolder {
    readonly fn: (args: unknown) => Promise<unknown>;
    readonly thisArg: unknown;
}

export function resolvePath(root: object, path: readonly string[]): MethodHolder | undefined {
    if (path.length === 0) return undefined;
    let cursor: unknown = root;
    for (let i = 0; i < path.length - 1; i += 1) {
        if (cursor === null || typeof cursor !== "object") return undefined;
        const segment = path[i];
        if (segment === undefined) return undefined;
        cursor = (cursor as Record<string, unknown>)[segment];
        if (cursor === undefined) return undefined;
    }
    const last = path[path.length - 1];
    if (last === undefined || cursor === null || typeof cursor !== "object") return undefined;
    const fn = (cursor as Record<string, unknown>)[last];
    if (typeof fn !== "function") return undefined;
    return { fn: fn as (args: unknown) => Promise<unknown>, thisArg: cursor };
}
