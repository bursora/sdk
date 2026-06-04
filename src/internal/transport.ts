/**
 * HTTP transport primitive. Wraps fetch + AbortController + timeout into a
 * single non-throwing surface. Categorizes failures so callers don't repeat
 * the boilerplate.
 */

export type FailureCategory =
    | "auth_invalid"
    | "network_unavailable"
    | "rate_limited"
    | "server_error"
    | "invalid_response"
    | "invalid_config";

export interface HttpRequest {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly timeoutMs: number;
}

export interface HttpResult {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    readonly categoryOnFailure?: FailureCategory;
    readonly timedOut?: boolean;
}

export interface Transport {
    send(req: HttpRequest): Promise<HttpResult>;
}

export interface TransportOptions {
    readonly fetch?: typeof fetch;
}

export function createTransport(opts: TransportOptions): Transport {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    return {
        async send(req: HttpRequest): Promise<HttpResult> {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), req.timeoutMs);
            let response: Response;
            try {
                const init: RequestInit = {
                    method: req.method,
                    headers: req.headers,
                    signal: controller.signal,
                };
                if (req.body !== undefined) init.body = req.body;
                response = await fetchImpl(req.url, init);
            } catch (err) {
                clearTimeout(timer);
                return {
                    ok: false,
                    status: 0,
                    categoryOnFailure: "network_unavailable",
                    timedOut: isAbortError(err),
                    json: () => Promise.reject(new Error("no response")),
                };
            }
            clearTimeout(timer);
            if (!response.ok) {
                return {
                    ok: false,
                    status: response.status,
                    categoryOnFailure: categorizeStatus(response.status),
                    json: () => response.json(),
                };
            }
            return {
                ok: true,
                status: response.status,
                json: () => response.json(),
            };
        },
    };
}

function categorizeStatus(status: number): FailureCategory {
    if (status === 401) return "auth_invalid";
    if (status === 429) return "rate_limited";
    return "server_error";
}

export function serializeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}
