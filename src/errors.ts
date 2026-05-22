/**
 * BudgetExceededError — thrown by the wrapper BEFORE the provider call when
 * the server returns `{ allow: false, mode: 'block' }`. Carries the tag scope
 * that triggered the block and the server-supplied reason so consumers can
 * render fallback UX or downgrade gracefully.
 */

import type { BudgetMode, Tags } from "./types";

export interface BudgetExceededErrorInit {
    readonly tag: Tags;
    readonly reason: string;
    readonly mode: BudgetMode;
}

export class BudgetExceededError extends Error {
    readonly tag: Tags;
    readonly reason: string;
    readonly mode: BudgetMode;

    constructor(init: BudgetExceededErrorInit) {
        super(`Budget exceeded: ${init.reason}`);
        this.name = "BudgetExceededError";
        this.tag = init.tag;
        this.reason = init.reason;
        this.mode = init.mode;
    }
}
