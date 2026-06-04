/**
 * Shared call-lifecycle primitives used by every wrap surface.
 *
 * Both the client-Proxy path (`internal/wrap-call.ts`) and the Vercel AI SDK
 * middleware (`../providers/ai-sdk.ts`) gate the call the same way and shape the usage
 * event the same way; this module owns that logic so neither path
 * re-implements it.
 */

import { BudgetExceededError } from "../errors";
import type { Decision, Tags, UsageTotals } from "../types";
import type { CallIntent } from "./decision";
import type { EventInput } from "./events";

/**
 * Resolves a (Tags, CallIntent) pair to a budget decision. The default
 * implementation is the in-process LRU client (`createDecisionClient`);
 * callers may supply any object of this shape.
 *
 * @internal
 */
export interface DecisionLookup {
    fetchDecision(tags: Tags, intent?: CallIntent): Promise<Decision | null>;
}

/** Provider slug + model id stamped onto the recorded usage event. */
export interface RecordTarget {
    readonly provider: string;
    readonly model: string;
}

/**
 * Pre-call budget gate. Fetches the decision for `tags` + `intent` and throws
 * `BudgetExceededError` when a `block`-mode budget denies it — so the provider
 * call never goes out. Fail-open: a `null` decision (server unreachable) or any
 * non-block verdict returns and the call proceeds.
 */
export async function preflightGate(
    decision: DecisionLookup,
    tags: Tags,
    intent: CallIntent,
): Promise<void> {
    const verdict = await decision.fetchDecision(tags, intent);
    if (verdict !== null && !verdict.allow && verdict.mode === "block") {
        throw new BudgetExceededError({ tag: tags, reason: verdict.reason, mode: verdict.mode });
    }
}

/**
 * Builds one usage event. `usage === null` is the errored path (0/0 tokens, no
 * cache/requestId). Cache tokens and requestId are omitted when `undefined`, so
 * a stream that read zero cache must pass `cacheTokens: undefined`, not `0`.
 */
export function buildEventInput(
    target: RecordTarget,
    tags: Tags,
    startedAt: number,
    finishedAt: number,
    usage: UsageTotals | null,
    errored: boolean,
): EventInput {
    return {
        provider: target.provider,
        model: target.model,
        ts: new Date(startedAt).toISOString(),
        tenantId: tags.tenant_id ?? null,
        agentId: tags.agent_id ?? null,
        workflowId: tags.workflow_id ?? null,
        latencyMs: finishedAt - startedAt,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        ...(usage?.cacheTokens === undefined ? {} : { cacheTokens: usage.cacheTokens }),
        ...(usage?.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(usage?.cacheWrite1hTokens === undefined
            ? {}
            : { cacheWrite1hTokens: usage.cacheWrite1hTokens }),
        ...(usage?.requestId === undefined ? {} : { requestId: usage.requestId }),
        ...(errored ? { errored: true } : {}),
    };
}
