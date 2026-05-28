/**
 * Scope cache key + version envelope behaviors.
 *
 * The decision client's cache uses a branded `ScopeKey` so the join format is
 * an explicit type, not an implicit convention, and wraps each entry in a
 * versioned envelope so a future key-format bump can ignore stale entries
 * instead of silently mis-keying them. These tests cover:
 *
 *  - `scopeKey()` is a pure factory: same inputs produce the same string.
 *  - The brand is structurally a string (assignable to ScopeKey at compile
 *    time, equal to the joined string at runtime).
 *  - Versioned reads evict and report a miss when the stored entry's version
 *    doesn't match the expected version (the format-evolution escape hatch).
 *  - Matching-version reads return the wrapped value untouched.
 */

import { describe, expect, test } from "bun:test";
import { LRUCache } from "../src/internal/cache";
import {
    readVersionedEntry,
    SCOPE_KEY_VERSION,
    scopeKey,
    type ScopeKey,
    type VersionedCacheEntry,
} from "../src/internal/decision";

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

describe("readVersionedEntry()", () => {
    const decision = {
        allow: true,
        mode: "notify" as const,
        reason: "ok",
        ttl_s: 60,
    };

    test("returns the wrapped value when version matches", () => {
        const cache = new LRUCache<VersionedCacheEntry<typeof decision>>({
            capacity: 4,
            now: () => 0,
        });
        const key = scopeKey("acme", undefined, undefined);
        cache.set(key, { version: SCOPE_KEY_VERSION, value: decision }, 60);
        expect(readVersionedEntry(cache, key, SCOPE_KEY_VERSION)).toBe(decision);
    });

    test("treats a stale-version entry as a miss and evicts it", () => {
        // Future-proofs the cache against a key-format bump: when
        // SCOPE_KEY_VERSION goes from 1 to 2, every v1 entry must be ignored
        // (not deserialized against the new format) AND dropped (so the next
        // write doesn't have to fight LRU residency for the same slot).
        const cache = new LRUCache<VersionedCacheEntry<typeof decision>>({
            capacity: 4,
            now: () => 0,
        });
        const key = scopeKey("acme", undefined, undefined);
        cache.set(key, { version: 1, value: decision }, 60);
        // Read with the next version (2) simulates the future bump. The v1
        // entry must be reported as a miss AND removed.
        expect(readVersionedEntry(cache, key, 2)).toBeUndefined();
        expect(cache.get(key)).toBeUndefined();
    });

    test("returns undefined and does not throw when the key is absent", () => {
        const cache = new LRUCache<VersionedCacheEntry<typeof decision>>({
            capacity: 4,
            now: () => 0,
        });
        const key = scopeKey("absent", undefined, undefined);
        expect(readVersionedEntry(cache, key, SCOPE_KEY_VERSION)).toBeUndefined();
    });
});

describe("SCOPE_KEY_VERSION", () => {
    test("ships as 1 (production format)", () => {
        // The constant exists to enable future format bumps. It MUST stay at
        // 1 in shipped code; bumping it implicitly invalidates every
        // long-lived cache entry in deployed SDKs. If you change this value,
        // the bump is a deliberate API event and this assertion is your
        // reminder to coordinate it.
        expect(SCOPE_KEY_VERSION).toBe(1);
    });
});
