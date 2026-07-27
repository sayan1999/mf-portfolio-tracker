import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "../../../../lib/mcp-auth-provider";
import { TokenStore, TOKEN_COOKIE } from "../../../../lib/token-store";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

export async function POST(req: NextRequest) {
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);
  if (!store.get().accessToken) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });

  const { tool, args } = await req.json();

  const authProvider = buildAuthProvider(store, req);
  const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });
  const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args ?? {} });
    await client.close();
    const res = NextResponse.json({ status: "OK", result });
    if (store.isDirty) {
      const { value, options } = await store.toCookieOptions();
      res.cookies.set(TOKEN_COOKIE, value, options as Parameters<typeof res.cookies.set>[2]);
    }
    return res;
  } catch (err) {
    await client.close().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("unauthorized") || authProvider.capturedAuthUrl) {
      store.clearTokens();
      return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
    }
    return NextResponse.json({ status: "ERROR", message: msg }, { status: 500 });
  }
}
