/**
 * baseURLIncludes — generic baseURL detector factory.
 *
 * The SDK supports providers that ship no first-party client (DeepSeek) by
 * wrapping a structurally-compatible client (openai/anthropic) and overriding
 * `baseURL`. This helper produces the predicate used by such manifests.
 */

import { describe, expect, test } from "bun:test";
import { baseURLIncludes } from "../src/internal/detect";

describe("baseURLIncludes", () => {
    test("returns true when client.baseURL is a string containing the substring", () => {
        const matches = baseURLIncludes("deepseek");
        expect(matches({ baseURL: "https://api.deepseek.com" })).toBe(true);
    });

    test("returns true when substring appears anywhere in the baseURL", () => {
        const matches = baseURLIncludes("deepseek");
        expect(matches({ baseURL: "https://api.deepseek.com/anthropic" })).toBe(true);
    });

    test("returns false when baseURL is a string that does not contain the substring", () => {
        const matches = baseURLIncludes("deepseek");
        expect(matches({ baseURL: "https://api.openai.com/v1" })).toBe(false);
    });

    test("returns false when baseURL is missing", () => {
        const matches = baseURLIncludes("deepseek");
        expect(matches({})).toBe(false);
    });

    test("returns false when baseURL is not a string", () => {
        const matches = baseURLIncludes("deepseek");
        expect(matches({ baseURL: { toString: () => "https://api.deepseek.com" } })).toBe(false);
        expect(matches({ baseURL: 42 })).toBe(false);
        expect(matches({ baseURL: null })).toBe(false);
    });
});
