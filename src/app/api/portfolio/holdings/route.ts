import { NextRequest, NextResponse } from "next/server";
import { callTool, AuthRequiredError } from "../../../../lib/mcp-client";
import { getCached, setCached, bustCache } from "../../../../lib/cache";

export async function GET(req: NextRequest) {
  const sessionId = req.cookies.get("mcp_session")?.value;
  if (!sessionId) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });

  const force = req.nextUrl.searchParams.get("force") === "1";
  const cacheKey = `mf:holdings:${sessionId}`;

  if (!force) {
    const cached = getCached<unknown[]>(cacheKey);
    if (cached) return NextResponse.json({ status: "OK", holdings: cached, cached: true });
  } else {
    bustCache(cacheKey);
  }

  try {
    const data = await callTool(sessionId, "networth_holdings", { asset_type: "MF" }) as { holdings: unknown[] };
    const holdings = data?.holdings ?? [];
    setCached(cacheKey, holdings);
    return NextResponse.json({ status: "OK", holdings });
  } catch (err) {
    if (err instanceof AuthRequiredError) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
    return NextResponse.json({ status: "ERROR", message: String(err) }, { status: 500 });
  }
}
