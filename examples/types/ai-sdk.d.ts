/**
 * Local stubs for `ai` and `@ai-sdk/openai`, used by examples/ so the Vercel
 * AI SDK quickstart type-checks without pulling those packages into the repo's
 * deps. Mirrors only the surface the quickstart touches. `bursoraMiddleware`
 * returns a structural middleware (its `wrapGenerate`/`wrapStream` methods) that
 * drops into `wrapLanguageModel`. When a user copy-pastes the example into a
 * project where `ai` is installed, the import resolves to the real package.
 */

declare module "@ai-sdk/openai" {
    export function openai(modelId: string): {
        readonly provider: string;
        readonly modelId: string;
    };
}

declare module "ai" {
    interface LanguageModelLike {
        readonly provider: string;
        readonly modelId: string;
    }

    interface LanguageModelMiddlewareLike {
        readonly wrapGenerate?: unknown;
        readonly wrapStream?: unknown;
    }

    export function wrapLanguageModel<M extends LanguageModelLike>(opts: {
        model: M;
        middleware: LanguageModelMiddlewareLike;
    }): M;

    export function generateText(opts: {
        model: LanguageModelLike;
        prompt: string;
    }): Promise<{ readonly text: string }>;
}
