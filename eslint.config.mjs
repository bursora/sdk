// Flat ESLint config for @bursora/sdk.
//
// Composes @eslint/js recommended + typescript-eslint strict (type-aware).
// Mirrors the root app's eslint.config.js shape; plain TS library — no React/Next.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
    { ignores: ["node_modules/**", "dist/**"] },
    eslint.configs.recommended,
    ...tseslint.configs.strict,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "error",
        },
    },
];
