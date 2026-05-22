/**
 * Tag inheritance: `withTags` merges child tags into the parent context.
 *
 * The marked region below shows nested usage — the inner call inherits
 * tenant_id from the outer scope and adds agent_id. Bursora uses these
 * tags to scope budgets and group spend in the dashboard.
 */

import { wrap } from "@bursora/sdk";
import OpenAI from "openai";

const openai = wrap(new OpenAI(), {
    apiKey: process.env.BURSORA_API_KEY ?? "",
    endpoint: process.env.BURSORA_ENDPOINT ?? "",
});

// region:withtags-nested
import { withTags } from "@bursora/sdk";

await withTags({ tenant_id: "acme" }, async () => {
    // every wrapped call here is tagged tenant_id=acme.
    await withTags({ agent_id: "support-bot" }, async () => {
        // this call is tagged tenant_id=acme AND agent_id=support-bot.
        await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
    });
});
// endregion
