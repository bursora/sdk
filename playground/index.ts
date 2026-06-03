/**
 * Bursora SDK playground — interactive wizard.
 *
 *   bun run start
 *
 * Pick a mode, fill in the values (defaults pre-filled, enter to accept), run:
 *   seed     bulk-fill the dashboard with backdated events (direct ingest)
 *   anomaly  seed a baseline, fire a spike through the SDK wrap, trigger the
 *            alert cron
 *
 * Everything runs against the real local server: auth, ingest, budgets, cron.
 */

import { loadEnv } from "./env";
import { wizard } from "./wizard";

wizard(loadEnv()).catch((err: unknown) => {
    console.error("playground failed:", err);
    process.exit(1);
});
