/**
 * Scope cache key behaviors.
 *
 * The decision client's cache uses a branded `ScopeKey` so the join format is
 * an explicit type, not an implicit convention. These tests cover:
 *
 *  - `scopeKey()` is a pure factory: same inputs produce the same string.
 *  - The brand is structurally a string (assignable to ScopeKey at compile
 *    time, equal to the joined string at runtime).
 *  - Missing scope fields collapse to empty segments, matching the wire shape.
 */

import { describe, expect, test } from "bun:test";
import { scopeKey, type ScopeKey } from "../src/internal/decision";

describe("scopeKey()", () => {
    test("returns the same string for the same inputs", () => {
        const a = scopeKey("acme", "support", "checkout");
        const b = scopeKey("acme", "support", "checkout");
        expect(a).toBe(b);
    });

    test("returns a string assignable to ScopeKey", () => {
        // Compile-time check: the factory's return type IS ScopeKey, so the
        // explicit annotation must hold without casts. Runtime check: the
        // brand carries no value, so the result equals the joined string.
        const key: ScopeKey = scopeKey("acme", "support", "checkout");
        expect(key).toBe("acme|support|checkout" as ScopeKey);
    });

    test("treats missing scope fields as empty segments", () => {
        // Mirrors the wire contract: server-side scope keys collapse missing
        // tenant/agent/workflow to "", so the SDK cache must follow suit or
        // an undefined-vs-empty mismatch would split otherwise-equivalent
        // workspaces into two cache slots.
        const key = scopeKey(undefined, undefined, undefined);
        expect(key).toBe("||" as ScopeKey);
    });
});
