# Architecture — Auth, Token Lifecycle & Data Caching

---

## 1. Sign-in flow (full happy path)

```
Browser (original tab)          Next.js server                  mcp.indmoney.com
        |                             |                                |
        |  POST /api/mcp/connect      |                                |
        |─────────────────────────>   |                                |
        |                             |  StreamableHTTPClientTransport |
        |                             |  client.connect() ──────────> |
        |                             |                   <── 401 + WWW-Authenticate
        |                             |  SDK: discover /.well-known/oauth-authorization-server
        |                             |  SDK: POST /register (dynamic client reg)
        |                             |  SDK: build PKCE URL
        |                             |  authProvider.redirectToAuthorization(url)
        |                             |     → cell.authUrl captured (no real redirect)
        |  { AUTH_REQUIRED, authUrl } |                                |
        |  + Set-Cookie: mcp_session  |                                |
        |<─────────────────────────   |                                |
        |                             |                                |
        |  window.open(authUrl, "_blank")  ──────────────────────────>|
        |                             |                  user logs in  |
        |                             |                                |
        |             [new tab] GET /api/mcp/callback?code=xxx        |
        |                             |<────────────────────────────   |
        |                             |  transport.finishAuth(code)    |
        |                             |  ──── POST /token ──────────> |
        |                             |  <── { access_token, refresh_token, expires_in }
        |                             |  saveTokens() → session store  |
        |                             |  client.connect() (verify) ─> |
        |                             |  <── 200 OK                    |
        |             [new tab] → /auth-done                           |
        |             localStorage.setItem("mcp_auth_done","ok")       |
        |             window.close()                                    |
        |                             |                                |
        |  storage event fires        |                                |
        |  POST /api/mcp/connect      |                                |
        |─────────────────────────>   |  token in session → connect() |
        |  { CONNECTED, tools[] }     |  <── 200 OK                   |
        |<─────────────────────────   |                                |
```

---

## 2. Token failure & expiry cases

### 2a. Token expired before connect (detected client-side by expiry timestamp)

```
POST /api/mcp/connect
  → getSession(sessionId).expiresAt < Date.now()
  → clearSession(sessionId)           ← wipe access + refresh token
  → buildAuthProvider(fresh session)
  → client.connect() → 401 from MCP  → capturedAuthUrl set
  → return { AUTH_REQUIRED, authUrl }
  → browser opens login tab → full flow restarts
```

### 2b. Token rejected mid-session (MCP returns 401 on tool call)

```
POST /api/mcp/tool
  → client.callTool(...)
  → MCP returns 401 Unauthorized
  → catch: message contains "401" / "Unauthorized"
  → clearSession(sessionId)           ← wipe tokens
  → return HTTP 401 { status: "AUTH_REQUIRED" }
  → frontend: on 401 response → call connect() → AUTH_REQUIRED path → open login tab
```

### 2c. Refresh token path (if INDmoney server supplies one)

If `saveTokens` receives a `refresh_token`, we store it alongside `access_token`. Before clearing the session and forcing full re-login, we attempt one silent refresh:

```
refreshAuthorization(provider, { serverUrl, metadata })   ← SDK built-in
  → POST /token  grant_type=refresh_token
  → success → saveTokens(newTokens) → retry tool call
  → failure (400 / 401) → clearSession → AUTH_REQUIRED flow
```

This is transparent to the user; they only see the login tab if the refresh itself fails.

### 2d. Auth window closed by user / OAuth error

```
[new tab] /auth-done?error=access_denied
  → localStorage.setItem("mcp_auth_done", "access_denied")
  → window.close()
original tab storage event:
  → e.newValue !== "ok" → setError(`Auth failed: ${e.newValue}`) → state = "error"
  → user sees error + Retry button
```

---

## 3. Data caching strategy

MF portfolio data has a predictable staleness profile:
- **Holdings** (invested amount, units, cost basis): change only on transaction (buy/redeem/SIP). Practically static intraday.
- **Market value / P&L**: updates once daily when NAV is declared, typically 9–11 PM IST for previous trading day.
- **Fund details** (holdings, sector, market cap split): updated monthly by SEBI disclosure cycle, but INDmoney refreshes more frequently. Safe to treat as "once daily".

### Cache design

Server-side, in the existing `global._mcpStore` (or Redis in production), we add a `_cache` namespace separate from session tokens:

```
cache key: `mf:holdings:<sessionId>:<YYYY-MM-DD>`
cache key: `mf:funddetails:<sorted_fund_ids_hash>:<YYYY-MM-DD>`
TTL: until 11:59 PM IST of the same calendar day
```

Why date-keyed and not a fixed TTL?
- A 4-hour TTL set at 6 PM would expire at 10 PM, before NAV is even out.
- A 24-hour TTL set at 9 AM would serve stale data until 9 AM next day, missing the overnight NAV update.
- Date-keyed cache: the moment the calendar rolls to a new day (midnight IST), the key no longer matches → automatic invalidation. The next request fetches fresh NAV-updated data.

### Cache flow

```
POST /api/mcp/tool  { tool: "networth_holdings", ... }
  → check cache["mf:holdings:<sid>:<today_IST>"]
  → HIT  → return cached response instantly
  → MISS → call MCP → store result → return

POST /api/mcp/tool  { tool: "get_mf_funds_details", ... }
  → check cache["mf:funddetails:<ids_hash>:<today_IST>"]
  → HIT  → return cached response instantly
  → MISS → call MCP → store result → return
```

Manual "Refresh" button: passes `{ force: true }` in the request body → server skips cache read, hits MCP, overwrites cache entry.

### What is NOT cached

- OAuth tokens: managed separately in session store (never mixed with data cache).
- Filter state (broker / liquid+arb / regular): purely client-side, no server round-trip needed.
- No external APIs needed beyond INDmoney MCP — Groww APIs are dropped (INDmoney supplies all required data).

---

## 4. Issues in sample.html that the Next.js app fixes

| Problem in sample.html | Fix in Next.js app |
|---|---|
| Anthropic API key exposed in browser (direct `fetch` to `api.anthropic.com`) | All MCP calls go through server-side `/api/mcp/tool` — key never touches the browser |
| No session / auth — every page load is unauthenticated | Full OAuth 2.1 + PKCE via `mcp-auth-provider.ts` with session cookie |
| No caching — every Refresh re-fetches everything from scratch | Date-keyed server-side cache; Refresh bypasses it via `force: true` |
| Token expiry not handled — broken experience after session dies | Explicit expiry check on connect + 401 detection on tool calls → seamless re-auth |
| MCP called via Anthropic's `mcp-client-2025-04-04` beta shim (fragile, model-dependent) | Direct MCP SDK (`StreamableHTTPClientTransport`) — no LLM in the loop for data fetching |
| External Groww APIs planned for fund metadata | Dropped — INDmoney `get_mf_funds_details` supplies category, AUM, expense ratio, returns, holdings, sector, market cap natively |
