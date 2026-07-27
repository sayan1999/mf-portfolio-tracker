import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "../../../../lib/mcp-auth-provider";
import { clearSession, getSession } from "../../../../lib/session-store";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

function makeResponse(body: object, sessionId: string, isNew: boolean) {
  const res = NextResponse.json(body);
  if (isNew) {
    res.cookies.set("mcp_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  return res;
}

export async function POST(req: NextRequest) {
  const existingId = req.cookies.get("mcp_session")?.value;
  const sessionId = existingId ?? crypto.randomUUID();
  const isNew = !existingId;

  const session = getSession(sessionId);
  const isExpired =
    session.expiresAt && typeof session.expiresAt === "number"
      ? session.expiresAt < Date.now()
      : false;

  // Clear expired tokens so the SDK re-triggers auth
  if (isExpired) {
    clearSession(sessionId);
  }

  const authProvider = buildAuthProvider(sessionId);
  const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });
  const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();

    return makeResponse({ status: "CONNECTED", tools }, sessionId, isNew);
  } catch (err) {
    await client.close().catch(() => {});

    if (authProvider.capturedAuthUrl) {
      return makeResponse(
        { status: "AUTH_REQUIRED", authUrl: authProvider.capturedAuthUrl },
        sessionId,
        isNew
      );
    }

    // Token was rejected by server → clear and force re-auth
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("unauthorized")) {
      clearSession(sessionId);
      // Retry once — fresh session will trigger auth
      const authProvider2 = buildAuthProvider(sessionId);
      const transport2 = new StreamableHTTPClientTransport(MCP_URL, { authProvider: authProvider2 });
      const client2 = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });
      try {
        await client2.connect(transport2);
        await client2.close();
      } catch {
        await client2.close().catch(() => {});
      }
      if (authProvider2.capturedAuthUrl) {
        return makeResponse(
          { status: "AUTH_REQUIRED", authUrl: authProvider2.capturedAuthUrl },
          sessionId,
          true
        );
      }
    }

    return NextResponse.json({ status: "ERROR", message: msg }, { status: 500 });
  }
}
