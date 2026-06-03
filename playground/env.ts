export interface Env {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly cronSecret: string | undefined;
    readonly workspaceId: string;
}

export function loadEnv(): Env {
    const endpoint = process.env.BURSORA_ENDPOINT;
    const apiKey = process.env.BURSORA_API_KEY;
    if (!endpoint || !apiKey) {
        console.error("Missing BURSORA_ENDPOINT or BURSORA_API_KEY. Edit playground/.env.");
        process.exit(1);
    }
    const parts = apiKey.split("_");
    if (parts.length !== 3 || parts[0] !== "bsk" || !parts[1]) {
        console.error("BURSORA_API_KEY must match bsk_<workspaceId>_<32hex>");
        process.exit(1);
    }
    return {
        endpoint,
        apiKey,
        cronSecret: process.env.BURSORA_CRON_SECRET || undefined,
        workspaceId: parts[1],
    };
}
