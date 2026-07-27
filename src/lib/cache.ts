const g = global as typeof global & { _mcpCache?: Map<string, unknown> };
if (!g._mcpCache) g._mcpCache = new Map();
const store = g._mcpCache;

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function getCached<T>(key: string): T | null {
  const val = store.get(`${key}:${todayIST()}`);
  return val !== undefined ? (val as T) : null;
}

export function setCached(key: string, value: unknown): void {
  store.set(`${key}:${todayIST()}`, value);
}

export function bustCache(key: string): void {
  store.delete(`${key}:${todayIST()}`);
}
