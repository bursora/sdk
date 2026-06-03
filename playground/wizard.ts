import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import { anomaly, ANOMALY_DEFAULTS } from "./anomaly";
import type { Env } from "./env";
import { seed, SEED_DEFAULTS } from "./seed";
import type { RequestRange } from "./usage";

async function promptNum(message: string, initial: number): Promise<number> {
    const value = await text({
        message,
        initialValue: String(initial),
        validate: (s) => {
            const n = Number(s);
            if (!Number.isFinite(n) || n < 0) return "must be a non-negative number";
            return undefined;
        },
    });
    if (isCancel(value)) {
        cancel("cancelled");
        process.exit(0);
    }
    return Number(value);
}

async function promptRange(d: RequestRange): Promise<RequestRange> {
    return {
        min: await promptNum("min tokens per request", d.min),
        max: await promptNum("max tokens per request", d.max),
    };
}

export async function wizard(env: Env): Promise<void> {
    intro("Bursora playground");
    const mode = await select({
        message: "What to run?",
        options: [
            { value: "seed", label: "seed", hint: "bulk-fill the dashboard with backdated events" },
            {
                value: "anomaly",
                label: "anomaly",
                hint: "seed a baseline, fire a spike, trigger the alert",
            },
        ],
    });
    if (isCancel(mode)) {
        cancel("cancelled");
        process.exit(0);
    }

    if (mode === "seed") {
        await seed(env, {
            events: await promptNum("how many events?", SEED_DEFAULTS.events),
            days: await promptNum("spread back over how many days?", SEED_DEFAULTS.days),
            range: await promptRange(SEED_DEFAULTS.range),
        });
    } else {
        await anomaly(env, {
            calls: await promptNum("how many spike calls?", ANOMALY_DEFAULTS.calls),
            interval: await promptNum("delay between calls (ms)", ANOMALY_DEFAULTS.interval),
            range: await promptRange(ANOMALY_DEFAULTS.range),
        });
    }
    outro("done");
}
