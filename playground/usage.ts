/**
 * Synthetic usage and a mock provider client. No real network call; returns
 * real-shaped token counts so pricing and the dashboard see plausible data.
 */

/** Per-request size band, in tokens. Bigger band -> costlier requests. */
export interface RequestRange {
    readonly min: number;
    readonly max: number;
}

/** Output tokens cost more than input; this is their share of each request. */
const COMPLETION_SHARE = 0.2;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const rand = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;

export function pick<T>(arr: readonly T[]): T {
    const value = arr[rand(0, arr.length - 1)];
    if (value === undefined) throw new Error("pick: empty array");
    return value;
}

/** Pick a random request size and split it into prompt/completion tokens. */
export function splitTokens(range: RequestRange): {
    readonly promptTokens: number;
    readonly completionTokens: number;
} {
    const total = rand(range.min, range.max);
    const completionTokens = Math.round(total * COMPLETION_SHARE);
    return { promptTokens: total - completionTokens, completionTokens };
}

interface ChatCompletion {
    readonly id: string;
    readonly model: string;
    readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number };
    readonly choices: readonly { readonly message: { readonly content: string } }[];
}

interface EmbeddingsResponse {
    readonly id: string;
    readonly model: string;
    readonly data: readonly { readonly embedding: readonly number[] }[];
    readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

/**
 * Mock OpenAI client shaped like the real one, wrappable by the SDK. Both
 * `chat.completions.create` and `embeddings.create` are required for the
 * SDK's provider detection to recognize it as OpenAI.
 */
export function makeMockOpenAI(range: RequestRange): {
    chat: { completions: { create: (args: { model: string }) => Promise<ChatCompletion> } };
    embeddings: { create: (args: { model: string }) => Promise<EmbeddingsResponse> };
} {
    return {
        chat: {
            completions: {
                create: async ({ model }) => {
                    const { promptTokens, completionTokens } = splitTokens(range);
                    return {
                        id: `chatcmpl-${rand(1000, 9999)}`,
                        model,
                        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
                        choices: [{ message: { content: "mock response" } }],
                    };
                },
            },
        },
        embeddings: {
            create: async ({ model }) => {
                const { promptTokens } = splitTokens(range);
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
