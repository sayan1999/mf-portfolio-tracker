// Resolve the public base URL for OAuth redirect URIs.
// Priority: NEXT_PUBLIC_BASE_URL → VERCEL_URL (Vercel injects this) → localhost fallback
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
