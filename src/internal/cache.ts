/** Map-based LRU with per-entry TTL. Insertion order = LRU; head is evicted. */

interface Entry<V> {
    readonly value: V;
    readonly expiresAt: number;
}

export interface LRUCacheOptions {
    readonly capacity: number;
    readonly now: () => number;
}

export class LRUCache<V, K extends string = string> {
    private readonly entries = new Map<K, Entry<V>>();
    private readonly capacity: number;
    private readonly now: () => number;

    constructor(opts: LRUCacheOptions) {
        if (opts.capacity <= 0) {
            throw new Error("LRUCache capacity must be positive");
        }
        this.capacity = opts.capacity;
        this.now = opts.now;
    }

    get(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V, ttlSeconds: number): void {
        // Non-finite ttl would yield a non-finite expiresAt, making the entry
        // un-evictable via the TTL check. Drop poison writes.
        if (!Number.isFinite(ttlSeconds)) return;
        const expiresAt = this.now() + ttlSeconds * 1_000;
        if (this.entries.has(key)) {
            this.entries.delete(key);
        } else if (this.entries.size >= this.capacity) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) {
                this.entries.delete(oldest);
            }
        }
        this.entries.set(key, { value, expiresAt });
    }

    delete(key: K): void {
        this.entries.delete(key);
    }
}
