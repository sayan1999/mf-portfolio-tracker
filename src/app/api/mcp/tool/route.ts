import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "../../../../lib/mcp-auth-provider";
import { clearSession } from "../../../../lib/session-store";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get("mcp_session")?.value;
  if (!sessionId) {
    return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
  }

  const { tool, args } = await req.json();

  const authProvider = buildAuthProvider(sessionId);
  const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });
  const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args ?? {} });
    await client.close();
    return NextResponse.json({ status: "OK", result });
  } catch (err) {
    await client.close().catch(() => {});

    const msg = err instanceof Error ? err.message : String(err);

    // Token expired / rejected → clear session so next /connect re-auths
    if (
      msg.includes("401") ||
      msg.includes("Unauthorized") ||
      msg.includes("unauthorized") ||
      authProvider.capturedAuthUrl
    ) {
      clearSession(sessionId);
      return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
    }

    return NextResponse.json({ status: "ERROR", message: msg }, { status: 500 });
  }
}
