/**
 * Local stub for the `openai` package, used by examples/ so this directory
 * type-checks without pulling the real package into the repo's deps. The
 * shape mirrors what `wrap(client, core)` reads structurally
 * — it is a small subset of the real client. When a user copy-pastes one of
 * these examples into their own project (where `openai` is installed), the
 * import resolves to the real package and the structural types still line up.
 */

declare module "openai" {
    interface ChatCompletion {
        readonly id?: string;
        readonly choices: ReadonlyArray<{
            readonly message?: { readonly content?: string | null };
        }>;
        readonly usage?: {
            readonly prompt_tokens: number;
            readonly completion_tokens: number;
        };
    }

    interface ChatCreateParams {
        readonly model: string;
        readonly messages: ReadonlyArray<{
            readonly role: "system" | "user" | "assistant";
            readonly content: string;
        }>;
        readonly stream?: boolean;
    }

    interface OpenAIOptions {
        readonly apiKey?: string;
        readonly baseURL?: string;
    }

    class OpenAI {
        constructor(opts?: OpenAIOptions);
        readonly chat: {
            readonly completions: {
                create: (args: ChatCreateParams) => Promise<ChatCompletion>;
            };
        };
        readonly responses: {
            create: (args: ChatCreateParams) => Promise<ChatCompletion>;
        };
    }

    export default OpenAI;
}
