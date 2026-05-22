/**
 * BudgetExceededError carries the offending tag, the server's reason, and the
 * mode that caused the block. Consumers catch it via `instanceof` and read
 * the fields to render fallback UX.
 */

import { describe, expect, test } from "bun:test";
import { BudgetExceededError } from "../src/errors";

describe("BudgetExceededError", () => {
    test("is an Error subclass", () => {
        const err = new BudgetExceededError({
            tag: { tenant_id: "acme" },
            reason: "daily-cap-exceeded",
            mode: "block",
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(BudgetExceededError);
        expect(err.name).toBe("BudgetExceededError");
    });

    test("carries tag, reason, and mode", () => {
        const err = new BudgetExceededError({
            tag: { agent_id: "support" },
            reason: "monthly-budget-exhausted",
            mode: "block",
        });
        expect(err.tag).toEqual({ agent_id: "support" });
        expect(err.reason).toBe("monthly-budget-exhausted");
        expect(err.mode).toBe("block");
    });

    test("message includes the reason", () => {
        const err = new BudgetExceededError({
            tag: {},
            reason: "daily-cap-exceeded",
            mode: "block",
        });
        expect(err.message).toContain("daily-cap-exceeded");
    });
});
