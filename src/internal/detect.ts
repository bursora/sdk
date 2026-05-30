/**
 * Composable detect predicates used by provider manifests.
 *
 * Every `ProviderManifest.detect` answers the single question: "is this
 * client an instance of my provider?" One primitive covers today's needs:
 *
 *  - `structurallyMatches(methods)` — true when every non-optional method
 *    path on the spec list resolves to a function on the client. Owned by
 *    OpenAI and Anthropic, which detect purely by client shape.
 *
 * Detection stays declarative inside each provider file; the wrap engine just
 * iterates manifests and asks. The provider slug an event carries is a
 * separate concern, resolved from the client's `baseURL` (see
 * `provider-from-base-url.ts`).
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
