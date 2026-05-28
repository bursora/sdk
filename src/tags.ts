/**
 * Tag context propagation via AsyncLocalStorage.
 *
 * `withTags` runs a function with a tag bag attached to the async context.
 * Nested calls merge with the parent context (child wins on collision). Tags
 * are read by the wrapper at call time, so callers don't have to pass them
 * down through every layer.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Tags } from "./types";

const storage = new AsyncLocalStorage<Tags>();

/**
 * Read the current tags. Outside a `withTags` scope, returns an empty object.
 * Returns a copy; safe to mutate without leaking back into the ALS context.
 */
export function currentTags(): Tags {
    const raw = storage.getStore();
    return raw === undefined ? {} : { ...raw };
}

/**
 * Run `body` with `tags` merged into the async context. Nested invocations
 * merge with the parent: parent tags are preserved, child tags override on
 * key collision. The merge applies for the duration of `body` and any async
 * work it awaits.
 */
export async function withTags<T>(tags: Tags, body: () => Promise<T>): Promise<T> {
    const parent = storage.getStore() ?? {};
    const merged: Tags = { ...parent, ...tags };
    return storage.run(merged, body);
}
