/**
 * buildProxy — path-walking nested Proxy constructor used by wrap().
 *
 * Given a target client and a map of leaf overrides keyed by dotted paths
 * (e.g. "chat.completions.create"), returns a Proxy tree that:
 *   - returns the wrapped fn at registered leaf paths
 *   - returns nested Proxies for intermediate segments
 *   - falls through via Reflect.get for unrelated props
 *   - grafts lifecycle props (flush/dispose) at root only when absent
 *   - skips paths whose intermediate segments are missing on the target
 */

import { describe, expect, test } from "bun:test";
import { buildProxy } from "../src/internal/proxy-builder";

describe("buildProxy — leaf overrides", () => {
    test("returns the wrapped fn at a registered leaf path", () => {
        const wrapped = () => "wrapped";
        const target = {
            chat: {
                completions: {
                    create: () => "original",
                },
            },
        };
        const proxy = buildProxy(target, {
            leaves: new Map([["chat.completions.create", wrapped]]),
            lifecycle: {},
        });
        expect((proxy as typeof target).chat.completions.create()).toBe("wrapped");
    });

    test("returns nested proxies for intermediate segments", () => {
        const wrapped = () => "wrapped";
        const target = {
            a: { b: { c: { d: () => "deep" } } },
        };
        const proxy = buildProxy(target, {
            leaves: new Map([["a.b.c.d", wrapped]]),
            lifecycle: {},
        });
        // Three+ levels deep
        expect((proxy as typeof target).a.b.c.d()).toBe("wrapped");
    });
});

describe("buildProxy — fall-through", () => {
    test("falls through via Reflect.get for unrelated props", () => {
        const target = {
            chat: {
                completions: {
                    create: () => "wrapped",
                },
            },
            apiKey: "sk-test",
            other: { value: 42 },
        };
        const proxy = buildProxy(target, {
            leaves: new Map([["chat.completions.create", () => "wrapped"]]),
            lifecycle: {},
        });
        expect((proxy as typeof target).apiKey).toBe("sk-test");
        expect((proxy as typeof target).other.value).toBe(42);
    });

    test("returns the original method when sibling leaf is wrapped but this one is not", () => {
        const target = {
            chat: {
                completions: {
                    create: () => "wrapped",
                    parse: () => "untouched",
                },
            },
        };
        const proxy = buildProxy(target, {
            leaves: new Map([["chat.completions.create", () => "wrapped"]]),
            lifecycle: {},
        });
        expect((proxy as typeof target).chat.completions.parse()).toBe("untouched");
        expect((proxy as typeof target).chat.completions.create()).toBe("wrapped");
    });
});

describe("buildProxy — missing optional paths", () => {
    test("does not error when a registered path is missing on the target", () => {
        const target = {
            chat: {
                completions: {
                    create: () => "wrapped",
                },
            },
        };
        // 'responses.create' is not present on target — must be skipped silently.
        const proxy = buildProxy(target, {
            leaves: new Map([
                ["chat.completions.create", () => "wrapped"],
                ["responses.create", () => "wont-exist"],
            ]),
            lifecycle: {},
        });
        expect((proxy as { responses?: unknown }).responses).toBeUndefined();
        expect((proxy as typeof target).chat.completions.create()).toBe("wrapped");
    });
});

describe("buildProxy — duplicate path detection", () => {
    test("throws when two leaves register the same dotted path", () => {
        const target = { chat: { completions: { create: () => "original" } } };
        expect(() =>
            buildProxy(target, {
                leaves: [
                    ["chat.completions.create", () => "first"],
                    ["chat.completions.create", () => "second"],
                ],
                lifecycle: {},
            }),
        ).toThrow(/buildProxy: duplicate method path 'chat\.completions\.create' in manifest/);
    });
});

describe("buildProxy — missing required paths fall back to no-op", () => {
    test("warns and installs a no-op when a required intermediate segment is missing on the target", () => {
        const target = {
            chat: {
                completions: {
                    create: () => "wrapped",
                },
            },
        };
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const proxy = buildProxy(target, {
                leaves: [
                    ["chat.completions.create", () => "wrapped"],
                    ["responses.create", () => undefined],
                ],
                requiredPaths: new Set(["chat.completions.create", "responses.create"]),
                lifecycle: {},
            }) as typeof target & { responses: { create: () => unknown } };

            // Init succeeds (no throw); calling the missing method returns undefined.
            expect(proxy.responses.create()).toBeUndefined();
            // Warn emitted exactly once for the missing required path with the stable prefix.
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toBe(
                "[bursora-sdk] missing required method responses.create; using no-op fallback",
            );
        } finally {
            console.warn = originalWarn;
        }
    });

    test("present sibling methods still execute normally when a required path is missing", () => {
        const target = {
            chat: {
                completions: {
                    create: () => "real-result",
                },
            },
        };
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            const proxy = buildProxy(target, {
                leaves: [
                    ["chat.completions.create", () => "wrapped-result"],
                    ["responses.create", () => undefined],
                ],
                requiredPaths: new Set(["chat.completions.create", "responses.create"]),
                lifecycle: {},
            }) as typeof target & { responses: { create: () => unknown } };

            // Present required path still routes through the wrapper.
            expect(proxy.chat.completions.create()).toBe("wrapped-result");
        } finally {
            console.warn = originalWarn;
        }
    });

    test("does not warn or install for required paths that resolve on the target", () => {
        const target = { chat: { completions: { create: () => "wrapped" } } };
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            buildProxy(target, {
                leaves: [["chat.completions.create", () => "wrapped"]],
                requiredPaths: new Set(["chat.completions.create"]),
                lifecycle: {},
            });
            expect(warnings).toHaveLength(0);
        } finally {
            console.warn = originalWarn;
        }
    });

    test("does not warn for missing optional paths (preserves existing skip-silently behavior)", () => {
        const target = { chat: { completions: { create: () => "wrapped" } } };
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (msg: unknown) => {
            warnings.push(String(msg));
        };
        try {
            const proxy = buildProxy(target, {
                leaves: [
                    ["chat.completions.create", () => "wrapped"],
                    ["responses.create", () => "skip-me"],
                ],
                // responses.create is NOT in requiredPaths — treat as optional.
                requiredPaths: new Set(["chat.completions.create"]),
                lifecycle: {},
            }) as { responses?: unknown; chat: { completions: { create: () => unknown } } };

            expect(warnings).toHaveLength(0);
            expect(proxy.responses).toBeUndefined();
        } finally {
            console.warn = originalWarn;
        }
    });
});

describe("buildProxy — lifecycle grafting", () => {
    test("grafts flush/dispose at root when absent on target", async () => {
        let flushed = 0;
        let disposed = 0;
        const target = { chat: { completions: { create: () => "wrapped" } } };
        const proxy = buildProxy(target, {
            leaves: new Map([["chat.completions.create", () => "wrapped"]]),
            lifecycle: {
                flush: async () => {
                    flushed += 1;
                },
                dispose: () => {
                    disposed += 1;
                },
            },
        });
        await (proxy as unknown as { flush: () => Promise<void> }).flush();
        (proxy as unknown as { dispose: () => void }).dispose();
        expect(flushed).toBe(1);
        expect(disposed).toBe(1);
    });

    test("does NOT graft when target already owns the prop", () => {
        const original = { hello: "world" };
        const target = {
            chat: { completions: { create: () => "wrapped" } },
            flush: () => original,
        };
        let grafted = 0;
        const proxy = buildProxy(target, {
            leaves: new Map([["chat.completions.create", () => "wrapped"]]),
            lifecycle: {
                flush: async () => {
                    grafted += 1;
                },
            },
        });
        const out = (proxy as typeof target).flush();
        expect(out).toBe(original);
        expect(grafted).toBe(0);
    });
});
