import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS build for `@bursora/sdk`.
 *
 *   - ESM emitted as `dist/index.mjs` (matches `package.json#module` + `exports.import`).
 *   - CJS emitted as `dist/index.cjs` (matches `package.json#main` + `exports.require`).
 *   - Type declarations emitted as `dist/index.d.ts`.
 *
 * `target: 'node18'` matches `engines.node`. Node 18 supports `node:async_hooks`
 * and modern fetch, which the SDK depends on.
 */
export default defineConfig({
    entry: ["src/index.ts"],
    tsconfig: "tsconfig.build.json",
    format: ["esm", "cjs"],
    outExtension: ({ format }) => ({ js: format === "esm" ? ".mjs" : ".cjs" }),
    dts: true,
    clean: true,
    target: "node18",
    sourcemap: true,
    minify: false,
    splitting: false,
});
