/**
 * Per-scope async mutex.
 *
 * Two concurrent wrapped calls on the same budget scope (tenant/agent/workflow)
 * must serialize their flush-then-decide critical section: otherwise call B's
 * decision lookup can race past call A's pending flush, and the server computes
 * B's budget from a stale event snapshot.
 *
 * Implementation: a per-key tail promise. Each new caller chains its work after
 * the previous holder's release and replaces the tail with its own pending
 * promise; the map entry is dropped once the lock is idle so long-running
 * processes don't leak keys.
 */

import type { Tags } from "../types";

const tail = new Map<string, Promise<void>>();

/** Acquire the lock for `key`. Returns a `release` function the caller must invoke exactly once. */
export async function acquireScopeLock(key: string): Promise<() => void> {
    const prev = tail.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const ours = new Promise<void>((res) => {
        release = res;
    });
    tail.set(key, ours);
    await prev;
    return () => {
        release();
        if (tail.get(key) === ours) tail.delete(key);
    };
}

export function scopeKey(tags: Tags): string {
    return [tags.tenant_id ?? "", tags.agent_id ?? "", tags.workflow_id ?? ""].join("|");
}
