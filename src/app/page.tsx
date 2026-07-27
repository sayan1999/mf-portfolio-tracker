"use client";

import { useState, useEffect, useCallback } from "react";

type Tool = { name: string; description?: string };
type AppState = "idle" | "connecting" | "auth_pending" | "connected" | "error";

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [tools, setTools] = useState<Tool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [toolArgs, setToolArgs] = useState<string>("{}");
  const [toolResult, setToolResult] = useState<string | null>(null);
  const [toolLoading, setToolLoading] = useState(false);

  const connect = useCallback(async () => {
    setState("connecting");
    setError(null);

    try {
      const res = await fetch("/api/mcp/connect", { method: "POST" });
      const data = await res.json();

      if (data.status === "CONNECTED") {
        setTools(data.tools ?? []);
        setState("connected");
      } else if (data.status === "AUTH_REQUIRED") {
        setState("auth_pending");
        window.open(data.authUrl, "_blank");
      } else {
        setError(data.message ?? "Unknown error");
        setState("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  // Listen for auth completion signal from the popup tab
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== "mcp_auth_done") return;
      localStorage.removeItem("mcp_auth_done");
      if (e.newValue === "ok") {
        connect();
      } else {
        setError(`Auth failed: ${e.newValue}`);
        setState("error");
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [connect]);

  async function callTool() {
    setToolLoading(true);
    setToolResult(null);

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolArgs);
    } catch {
      setToolResult("Invalid JSON args");
      setToolLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/mcp/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: selectedTool, args }),
      });

      // Token expired → re-auth automatically
      if (res.status === 401) {
        const data = await res.json();
        if (data.status === "AUTH_REQUIRED") {
          setToolResult(null);
          setState("idle");
          connect();
          return;
        }
      }

      const data = await res.json();
      setToolResult(JSON.stringify(data.result ?? data, null, 2));
    } catch (e) {
      setToolResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setToolLoading(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>Portfolio Tracker</h1>
      <p style={styles.subtitle}>MCP OAuth client — INDmoney</p>

      {/* Connect button */}
      {state === "idle" && (
        <button onClick={connect} style={styles.btn}>
          Connect
        </button>
      )}

      {state === "connecting" && <p style={styles.status}>Connecting…</p>}

      {state === "auth_pending" && (
        <p style={styles.status}>
          A login window was opened. Complete authentication there — this page will update automatically.
        </p>
      )}

      {state === "error" && (
        <div>
          <p style={styles.errorText}>{error}</p>
          <button onClick={connect} style={styles.btn}>
            Retry
          </button>
        </div>
      )}

      {state === "connected" && (
        <div style={styles.panel}>
          <p style={{ ...styles.status, color: "#16a34a" }}>Connected — {tools.length} tools available</p>

          {/* Disconnect / reconnect */}
          <button onClick={connect} style={{ ...styles.btn, background: "#6b7280", marginBottom: 24 }}>
            Reconnect
          </button>

          {/* Tool selector */}
          <div style={styles.row}>
            <select
              style={styles.select}
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
            >
              <option value="">— select a tool —</option>
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {selectedTool && (
            <div>
              <p style={styles.label}>Arguments (JSON)</p>
              <textarea
                style={styles.textarea}
                value={toolArgs}
                onChange={(e) => setToolArgs(e.target.value)}
                rows={5}
              />
              <button
                onClick={callTool}
                style={styles.btn}
                disabled={toolLoading}
              >
                {toolLoading ? "Calling…" : `Call ${selectedTool}`}
              </button>
            </div>
          )}

          {toolResult && (
            <div>
              <p style={styles.label}>Result</p>
              <pre style={styles.pre}>{toolResult}</pre>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 700,
    margin: "60px auto",
    padding: "0 24px",
    fontFamily: "system-ui, sans-serif",
    color: "#1f2937",
  },
  title: { fontSize: 28, fontWeight: 700, margin: 0 },
  subtitle: { color: "#6b7280", marginTop: 4, marginBottom: 32 },
  status: { color: "#374151", marginBottom: 16 },
  errorText: { color: "#dc2626", marginBottom: 12 },
  btn: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    padding: "10px 22px",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
    marginBottom: 16,
  },
  panel: { marginTop: 8 },
  row: { marginBottom: 16 },
  select: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 14,
  },
  label: { fontWeight: 600, marginBottom: 6, marginTop: 16 },
  textarea: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontFamily: "monospace",
    fontSize: 13,
    boxSizing: "border-box",
  },
  pre: {
    background: "#f3f4f6",
    padding: 16,
    borderRadius: 8,
    overflowX: "auto",
    fontSize: 13,
    fontFamily: "monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
};
