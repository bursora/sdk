/**
 * Shared `.budget` headroom tap used by every wrap surface that returns a
 * `Wrapped<T>` (the manifest-driven `wrap()` and the Bedrock `wrapBedrock()`
 * proxy). Wraps a `DecisionLookup` so each decision fetch updates a
 * last-known-good `BudgetSnapshot`, and exposes a `readBudget()` accessor the
 * proxy grafts as `client.budget`.
 *
 * Last-known-good semantic: the underlying `LRUCache` hands back the same
 * Decision value on cache hits, so reference identity is a faithful
 * "fresh fetch vs cache hit" signal. Only a fresh, fully-validated decision
 * advances the snapshot; a later decision that omits the headroom fields leaves
 * the prior snapshot in place, so consumers polling between calls never see the
 * value flicker back to `null` mid-process.
 */

import type { BudgetSnapshot, Decision, Tags } from "../types";
import type { CallIntent } from "./decision";
import type { DecisionLookup } from "./lifecycle";

export interface BudgetSnapshotTap {
    /** Drop-in replacement for the source `DecisionLookup`, with the snapshot tap. */
    readonly decision: DecisionLookup;
    /** Current last-known-good headroom snapshot, or `null` if none yet. */
    readonly readBudget: () => BudgetSnapshot | null;
}

export function createBudgetSnapshotTap(source: DecisionLookup): BudgetSnapshotTap {
    let latestSnapshot: BudgetSnapshot | null = null;
    let lastDecision: Decision | null = null;
    const decision: DecisionLookup = {
        async fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null> {
            const next = await source.fetchDecision(tags, intent);
            if (next !== null && next !== lastDecision) {
                const snapshot = toBudgetSnapshot(next);
                if (snapshot !== null) latestSnapshot = snapshot;
                lastDecision = next;
            }
            return next;
        },
    };
    return { decision, readBudget: () => latestSnapshot };
}

function toBudgetSnapshot(decision: Decision): BudgetSnapshot | null {
    if (typeof decision.remainingUsd !== "number") return null;
    if (typeof decision.resetAt !== "string" || decision.resetAt === "") return null;
    return { remainingUsd: decision.remainingUsd, resetAt: decision.resetAt };
}
