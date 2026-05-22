/**
 * Mock provider client. Structurally compatible with what the SDK wrapper
 * expects — no real network call. Returns synthetic usage so the dashboard
 * sees real-shaped data.
 */

export interface MockUsageRange {
    readonly promptMin: number;
    readonly promptMax: number;
    readonly completionMin: number;
    readonly completionMax: number;
}

interface ChatCompletion {
    readonly id: string;
    readonly model: string;
    readonly usage: {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
    };
    readonly choices: readonly { readonly message: { readonly content: string } }[];
}

interface EmbeddingsResponse {
    readonly id: string;
    readonly model: string;
    readonly data: readonly { readonly embedding: readonly number[] }[];
    readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

const rand = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;

export function makeMockOpenAI(range: MockUsageRange): {
    chat: { completions: { create: (args: { model: string }) => Promise<ChatCompletion> } };
    embeddings: { create: (args: { model: string }) => Promise<EmbeddingsResponse> };
} {
    return {
        chat: {
            completions: {
                create: async ({ model }) => ({
                    id: `chatcmpl-${rand(1000, 9999)}`,
                    model,
                    usage: {
                        prompt_tokens: rand(range.promptMin, range.promptMax),
                        completion_tokens: rand(range.completionMin, range.completionMax),
                    },
                    choices: [{ message: { content: "mock response" } }],
                }),
            },
        },
        embeddings: {
            create: async ({ model }) => {
                const promptTokens = rand(range.promptMin, range.promptMax);
                return {
                    id: `embed-${rand(1000, 9999)}`,
                    model,
                    data: [{ embedding: [0.1, 0.2, 0.3] }],
                    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
                };
            },
        },
    };
}
