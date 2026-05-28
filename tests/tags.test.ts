/**
 * AsyncLocalStorage-based tag propagation.
 *
 * Tags must survive across `await` boundaries inside `withTags`. Nested
 * `withTags` calls merge with the parent tags (child wins on collision).
 * Outside any `withTags` scope, `currentTags()` returns an empty object.
 */

import { describe, expect, test } from "bun:test";
import { currentTags, withTags } from "../src/tags";

describe("withTags", () => {
    test("returns empty tags outside a scope", () => {
        expect(currentTags()).toEqual({});
    });

    test("propagates tags inside the synchronous body", async () => {
        await withTags({ tenant_id: "acme", agent_id: "support" }, async () => {
            expect(currentTags()).toEqual({ tenant_id: "acme", agent_id: "support" });
        });
    });

    test("propagates tags across an awaited Promise boundary", async () => {
        await withTags({ tenant_id: "acme" }, async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(currentTags()).toEqual({ tenant_id: "acme" });
            await Promise.resolve();
            expect(currentTags()).toEqual({ tenant_id: "acme" });
        });
    });

    test("nested scope merges with parent and child overrides", async () => {
        await withTags({ tenant_id: "acme", agent_id: "support" }, async () => {
            await withTags({ agent_id: "billing", workflow_id: "checkout" }, async () => {
                expect(currentTags()).toEqual({
                    tenant_id: "acme",
                    agent_id: "billing",
                    workflow_id: "checkout",
                });
            });
            // After nested scope exits, parent tags restored.
            expect(currentTags()).toEqual({ tenant_id: "acme", agent_id: "support" });
        });
    });

    test("tags do not leak outside the scope after it resolves", async () => {
        await withTags({ tenant_id: "acme" }, async () => {
            expect(currentTags().tenant_id).toBe("acme");
        });
        expect(currentTags()).toEqual({});
    });

    test("returns the body's resolved value", async () => {
        const result = await withTags({ tenant_id: "acme" }, async () => 42);
        expect(result).toBe(42);
    });

    test("propagates rejection from the body", async () => {
        await expect(
            withTags({ tenant_id: "acme" }, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
    });

    test("returned tags are a copy — mutations don't leak into ALS", async () => {
        await withTags({ tenant_id: "acme" }, async () => {
            const first = currentTags();
            (first as { tenant_id?: string }).tenant_id = "mutated";
            expect(currentTags().tenant_id).toBe("acme");
        });
    });
});
