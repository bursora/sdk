/**
 * Local stub for `@anthropic-ai/sdk`. Same rationale as openai.d.ts: keeps
 * examples/ self-contained for type-checking. Mirrors only the minimal
 * structural shape `wrap(client, core)` reads.
 */

declare module "@anthropic-ai/sdk" {
    interface MessagesCreateParams {
        readonly model: string;
        readonly max_tokens: number;
        readonly messages: ReadonlyArray<{
            readonly role: "user" | "assistant";
            readonly content: string;
        }>;
        readonly stream?: boolean;
    }

    interface AnthropicMessage {
        readonly id?: string;
        readonly content: ReadonlyArray<{
            readonly type: string;
            readonly text?: string;
        }>;
        readonly usage?: {
            readonly input_tokens: number;
            readonly output_tokens: number;
        };
    }

    interface AnthropicOptions {
        readonly apiKey?: string;
    }

    class Anthropic {
        constructor(opts?: AnthropicOptions);
        readonly messages: {
            create: (args: MessagesCreateParams) => Promise<AnthropicMessage>;
        };
    }

    export default Anthropic;
}
