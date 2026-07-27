"use client";

import { useEffect, useState } from "react";

export default function AuthDone() {
  const [msg, setMsg] = useState("Finishing authentication…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");

    localStorage.setItem("mcp_auth_done", error ?? "ok");

    if (error) {
      setMsg(`Auth failed: ${error}`);
    } else {
      setMsg("Authenticated! Closing this tab…");
      window.close();
    }
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui" }}>
      <p style={{ color: "#555" }}>{msg}</p>
    </div>
  );
}
