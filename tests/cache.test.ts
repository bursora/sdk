/**
 * In-process LRU cache with per-entry TTL.
 *
 * Used by the SDK to cache budget decisions for `ttl_s` seconds. Capacity
 * keeps memory bounded for high-cardinality scopes.
 */

import { describe, expect, test } from "bun:test";
import { LRUCache } from "../src/internal/cache";

describe("LRUCache", () => {
    test("returns undefined for an unknown key", () => {
        const cache = new LRUCache<string>({ capacity: 4, now: () => 0 });
        expect(cache.get("missing")).toBeUndefined();
    });

    test("returns the stored value within TTL", () => {
        let now = 1_000;
        const cache = new LRUCache<string>({ capacity: 4, now: () => now });
        cache.set("k", "v", 60);
        now = 1_010;
        expect(cache.get("k")).toBe("v");
    });

    test("returns undefined after TTL expiry", () => {
        let now = 1_000;
        const cache = new LRUCache<string>({ capacity: 4, now: () => now });
        cache.set("k", "v", 5);
        now = 1_006_000;
        expect(cache.get("k")).toBeUndefined();
    });

    test("evicts the least recently used entry when capacity exceeded", () => {
        const cache = new LRUCache<string>({ capacity: 2, now: () => 0 });
        cache.set("a", "1", 60);
        cache.set("b", "2", 60);
        cache.get("a"); // a most recently used now
        cache.set("c", "3", 60); // evicts b
        expect(cache.get("a")).toBe("1");
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("c")).toBe("3");
    });

    test("rejects non-finite ttl rather than storing a poison entry", () => {
        const cache = new LRUCache<string>({ capacity: 4, now: () => 1_000 });
        cache.set("k", "v", Number.NaN);
        expect(cache.get("k")).toBeUndefined();
        cache.set("k2", "v2", Number.POSITIVE_INFINITY);
        expect(cache.get("k2")).toBeUndefined();
    });

    test("overwrites an existing key without evicting other entries", () => {
        const cache = new LRUCache<string>({ capacity: 2, now: () => 0 });
        cache.set("a", "1", 60);
        cache.set("b", "2", 60);
        cache.set("a", "1-updated", 60);
        expect(cache.get("a")).toBe("1-updated");
        expect(cache.get("b")).toBe("2");
    });

    test("a block-entry stored with short ttl (10s) expires before the long-ttl window", () => {
        // Verifies the asymmetric TTL invariant from server-side evaluateBudget:
        // a cached block decision must be discarded well before the 60s allow TTL,
        // so a dashboard cap raise becomes visible to the SDK within ~10s.
        let now = 0;
        const cache = new LRUCache<string>({ capacity: 4, now: () => now });
        cache.set("blocked-scope", "block-decision", 10);
        now = 5_000; // 5s in: still fresh
        expect(cache.get("blocked-scope")).toBe("block-decision");
        now = 11_000; // 11s in: short TTL has expired
        expect(cache.get("blocked-scope")).toBeUndefined();
    });

    test("short TTL on one entry does not affect long-TTL entry stored alongside", () => {
        let now = 0;
        const cache = new LRUCache<string>({ capacity: 4, now: () => now });
        cache.set("blocked-scope", "block-decision", 10);
        cache.set("allow-scope", "allow-decision", 60);
        now = 11_000;
        expect(cache.get("blocked-scope")).toBeUndefined();
        expect(cache.get("allow-scope")).toBe("allow-decision");
    });
});
