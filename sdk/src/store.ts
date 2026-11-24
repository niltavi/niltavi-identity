// Everything the SDK remembers goes through this interface: application sessions, sign-ins in
// progress, and the notifications received from Identity. Values are plain JSON objects.
export type StoreValue = Record<string, unknown>;

export interface SessionStore {
  get(key: string): Promise<StoreValue | undefined>;
  // Replaces the value. The entry must disappear once ttlSeconds have passed.
  set(key: string, value: StoreValue, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// Keeps entries in this process. An application that runs more than one instance must supply
// a shared store, or a notification that reaches one instance would not end sessions on the others.
export class MemoryStore implements SessionStore {
  private readonly entries = new Map<string, { value: StoreValue; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepSeconds = 60) {
    this.sweeper = setInterval(() => this.sweep(), sweepSeconds * 1_000);
    this.sweeper.unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  async set(key: string, value: StoreValue, ttlSeconds: number) {
    this.entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlSeconds * 1_000 });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  close() {
    clearInterval(this.sweeper);
    this.entries.clear();
  }
}
