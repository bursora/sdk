/**
 * Local stub for `@google/genai`. Same rationale as openai.d.ts: keeps
 * examples/ self-contained for type-checking without pulling the real package
 * into the repo's deps. Mirrors only the minimal structural shape
 * `wrap(client, core)` reads off the native Gemini client. When a user
 * copy-pastes the example into their own project (where `@google/genai` is
 * installed), the import resolves to the real package.
 */

declare module "@google/genai" {
    interface GenerateContentParams {
        readonly model: string;
        readonly contents: string;
    }

    interface GenerateContentResponse {
        readonly text?: string;
        readonly responseId?: string;
        readonly usageMetadata?: {
            readonly promptTokenCount?: number;
            readonly candidatesTokenCount?: number;
            readonly totalTokenCount?: number;
        };
    }

    interface GoogleGenAIOptions {
        readonly apiKey?: string;
    }

    export class GoogleGenAI {
        constructor(opts?: GoogleGenAIOptions);
        readonly models: {
            generateContent: (args: GenerateContentParams) => Promise<GenerateContentResponse>;
        };
    }
}
