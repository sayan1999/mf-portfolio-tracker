import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "../../../../lib/mcp-auth-provider";
import { TokenStore, TOKEN_COOKIE } from "../../../../lib/token-store";
import { getBaseUrl } from "../../../../lib/base-url";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

export async function GET(req: NextRequest) {
  const BASE_URL = getBaseUrl();
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);

  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) return NextResponse.redirect(new URL(`/auth-done?error=${encodeURIComponent(error)}`, BASE_URL));
  if (!code) return NextResponse.redirect(new URL("/auth-done?error=no_code", BASE_URL));

  try {
    const authProvider = buildAuthProvider(store, req);
    const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });

    await transport.finishAuth(code);

    const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    await client.close();

    const res = NextResponse.redirect(new URL("/auth-done", BASE_URL));
    if (store.isDirty) {
      const { value, options } = await store.toCookieOptions();
      res.cookies.set(TOKEN_COOKIE, value, options as Parameters<typeof res.cookies.set>[2]);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(new URL(`/auth-done?error=${encodeURIComponent(msg)}`, BASE_URL));
  }
}
