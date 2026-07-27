import type { NextRequest } from "next/server";

// Always derive from the incoming request — works for localhost, LAN IP, Vercel, custom domains.
// x-forwarded-proto is set by Vercel/proxies for HTTPS.
export function getBaseUrl(req?: NextRequest): string {
  if (req) {
    const host = req.headers.get("host") ?? "localhost:3000";
    const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
}
