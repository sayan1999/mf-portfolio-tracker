// Pinned to global so it survives Next.js hot-module reloads between requests
const g = global as typeof global & { _mcpStore?: Map<string, Record<string, unknown>> };
if (!g._mcpStore) g._mcpStore = new Map();
const store = g._mcpStore;

export function getSession(id: string): Record<string, unknown> {
  return store.get(id) ?? {};
}

export function setSession(id: string, patch: Record<string, unknown>): void {
  store.set(id, { ...store.get(id), ...patch });
}

export function clearSession(id: string): void {
  store.delete(id);
}
