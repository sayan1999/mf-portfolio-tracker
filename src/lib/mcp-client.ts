import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAuthProvider } from "./mcp-auth-provider";
import type { TokenStore } from "./token-store";

const MCP_URL = new URL("https://mcp.indmoney.com/mcp");

export class AuthRequiredError extends Error {
  constructor() { super("AUTH_REQUIRED"); }
}

function parseResult(result: unknown): unknown {
  const r = result as Record<string, unknown>;

  if (r?.toolResult !== undefined) {
    const tr = r.toolResult;
    if (typeof tr === "string") { try { return JSON.parse(tr); } catch { return tr; } }
    return tr;
  }

  const content = (r?.content as Array<{ type: string; text?: string }>) ?? [];
  const text = content.filter(c => c.type === "text").map(c => c.text || "").join("");
  try {
    const outer = JSON.parse(text);
    if (typeof outer?.result === "string") return JSON.parse(outer.result);
    return outer;
  } catch {
    return text;
  }
}

export async function callTool(
  store: TokenStore,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const d = store.get();
  if (d.expiresAt && d.expiresAt < Date.now()) store.clearTokens();

  const authProvider = buildAuthProvider(store);
  const transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider });
  const client = new Client({ name: "portfolio-tracker", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    await client.close();
    if (result.isError) throw new Error(`Tool error: ${JSON.stringify(result.content)}`);
    return parseResult(result);
  } catch (err) {
    await client.close().catch(() => {});

    if (authProvider.capturedAuthUrl) {
      store.clearTokens();
      throw new AuthRequiredError();
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
      store.clearTokens();
      throw new AuthRequiredError();
    }

    throw err;
  }
}
