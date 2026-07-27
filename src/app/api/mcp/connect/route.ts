import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "../../../../lib/mcp-auth-provider";
import { TokenStore, TOKEN_COOKIE } from "../../../../lib/token-store";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

async function withTokenCookie(res: NextResponse, store: TokenStore): Promise<NextResponse> {
  if (!store.isDirty) return res;
  const { value, options } = await store.toCookieOptions();
  res.cookies.set(TOKEN_COOKIE, value, options as Parameters<typeof res.cookies.set>[2]);
  return res;
}

// Silent check — decrypts cookie only, never touches the MCP server
export async function GET(req: NextRequest) {
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);
  const d = store.get();
  if (!d.accessToken) return NextResponse.json({ status: "NOT_CONNECTED" });
  if (d.expiresAt && d.expiresAt < Date.now()) return NextResponse.json({ status: "NOT_CONNECTED", reason: "expired" });
  return NextResponse.json({ status: "CONNECTED" });
}

export async function POST(req: NextRequest) {
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);
  const d = store.get();

  if (d.expiresAt && d.expiresAt < Date.now()) store.clearTokens();

  const authProvider = buildAuthProvider(store, req);
  const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });
  const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();

    return withTokenCookie(NextResponse.json({ status: "CONNECTED", tools }), store);
  } catch (err) {
    await client.close().catch(() => {});

    if (authProvider.capturedAuthUrl) {
      return withTokenCookie(
        NextResponse.json({ status: "AUTH_REQUIRED", authUrl: authProvider.capturedAuthUrl }),
        store
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("unauthorized")) {
      store.clearTokens();
      // Retry once with cleared token
      const authProvider2 = buildAuthProvider(store, req);
      const transport2 = new StreamableHTTPClientTransport(MCP_URL, { authProvider: authProvider2 });
      const client2 = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });
      try {
        await client2.connect(transport2);
        await client2.close();
      } catch {
        await client2.close().catch(() => {});
      }
      if (authProvider2.capturedAuthUrl) {
        return withTokenCookie(
          NextResponse.json({ status: "AUTH_REQUIRED", authUrl: authProvider2.capturedAuthUrl }),
          store
        );
      }
    }

    return NextResponse.json({ status: "ERROR", message: msg }, { status: 500 });
  }
}
