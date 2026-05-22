/**
 * Composable detect predicates used by provider manifests.
 *
 * Every `ProviderManifest.detect` answers the single question: "is this
 * client an instance of my provider?" Two primitives cover today's needs:
 *
 *  - `structurallyMatches(methods)` — true when every non-optional method
 *    path on the spec list resolves to a function on the client. Owned by
 *    OpenAI and Anthropic, which detect purely by client shape.
 *  - `baseURLIncludes(substr)` — true when `client.baseURL` is a string
 *    containing `substr`. Used by drop-in compatible providers like
 *    DeepSeek that share an SDK class with another vendor.
 *
 * Compose them with `and(...preds)`. Detection stays declarative inside
 * each provider file; the wrap engine just iterates manifests and asks.
 */

import type { MethodSpec } from "../types";
import { resolvePath } from "./path-resolver";

export type Detect = (client: object) => boolean;

export function structurallyMatches(methods: readonly MethodSpec[]): Detect {
    return (client) =>
        methods.every(
            (spec) => spec.optional === true || resolvePath(client, spec.path) !== undefined,
        );
}

export function baseURLIncludes(substr: string): Detect {
    return (client) => {
        const url = (client as { baseURL?: unknown }).baseURL;
        return typeof url === "string" && url.includes(substr);
    };
}

export function and(...preds: readonly Detect[]): Detect {
    return (client) => preds.every((p) => p(client));
}
