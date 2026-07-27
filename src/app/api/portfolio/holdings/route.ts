import { NextRequest, NextResponse } from "next/server";
import { callTool, AuthRequiredError } from "../../../../lib/mcp-client";
import { getCached, setCached, bustCache } from "../../../../lib/cache";
import { TokenStore, TOKEN_COOKIE } from "../../../../lib/token-store";

export async function GET(req: NextRequest) {
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);
  if (!store.get().accessToken) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });

  const sessionId = req.cookies.get("mcp_session")?.value ?? "default";
  const force = req.nextUrl.searchParams.get("force") === "1";
  const cacheKey = `mf:holdings:${sessionId}`;

  if (!force) {
    const cached = getCached<unknown[]>(cacheKey);
    if (cached) return NextResponse.json({ status: "OK", holdings: cached, cached: true });
  } else {
    bustCache(cacheKey);
  }

  try {
    const data = await callTool(store, "networth_holdings", { asset_type: "MF" }) as { holdings: unknown[] };
    const holdings = data?.holdings ?? [];
    setCached(cacheKey, holdings);
    const res = NextResponse.json({ status: "OK", holdings });
    if (store.isDirty) {
      const { value, options } = await store.toCookieOptions();
      res.cookies.set(TOKEN_COOKIE, value, options as Parameters<typeof res.cookies.set>[2]);
    }
    return res;
  } catch (err) {
    if (err instanceof AuthRequiredError) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
    return NextResponse.json({ status: "ERROR", message: String(err) }, { status: 500 });
  }
}
