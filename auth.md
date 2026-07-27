# Auth & Token Lifecycle

## Sign-in flow

```
Browser (original tab)       Next.js server                mcp.indmoney.com
        |                          |                               |
        | POST /api/mcp/connect    |                               |
        |─────────────────────>    | client.connect() ──────────> |
        |                          |               <── 401 + WWW-Authenticate
        |                          | SDK: discover /.well-known, POST /register, build PKCE URL
        |                          | cell.authUrl captured (no real redirect)
        | { AUTH_REQUIRED, authUrl }|                              |
        | + Set-Cookie: mcp_token  |                               |
        |<─────────────────────    |                               |
        |                          |                               |
        | window.open(authUrl)     |                user logs in   |
        |                          |                               |
        |    [new tab] GET /api/mcp/callback?code=xxx             |
        |                          | transport.finishAuth(code)    |
        |                          | POST /token ────────────────> |
        |                          | <── { access_token, refresh_token, expires_in }
        |                          | saveTokens() → mcp_token cookie
        |    [new tab] → /auth-done → localStorage("mcp_auth_done","ok") → window.close()
        |                          |                               |
        | storage event fires      |                               |
        | POST /api/mcp/connect    | token in cookie → CONNECTED  |
        |<─────────────────────    |                               |
```

**Popup rule**: `window.open("about:blank")` must fire synchronously in the click handler. Setting `popup.location.href` happens after the async fetch resolves. Opening after `await` is blocked by the browser popup blocker.

---

## Token failure cases

**Expired (pre-flight):** `store.get().expiresAt < Date.now()` → `store.clearTokens()` → connect() → 401 from MCP → `AUTH_REQUIRED` → login tab opens.

**Rejected mid-session (tool call 401):** `callTool` catches 401/Unauthorized → `store.clearTokens()` → throws `AuthRequiredError` → route returns HTTP 401 → frontend calls `connect()`.

**OAuth error / user closes tab:** `/auth-done?error=...` → storage event on original tab → error state with Retry button.

---

## Token storage

Tokens are stored in an AES-GCM encrypted httpOnly cookie (`mcp_token`). Key = SHA-256 of `COOKIE_SECRET`. IV is random per write, prepended to ciphertext. `sameSite=lax`, `secure` in production only.

Encryption benefit: attacker who steals the cookie cannot extract the raw INDmoney token — they can only replay through your server, limited to what your API routes expose.

`TokenStore` is created per-request from the cookie, mutated by the auth provider, written back to the response if `store.isDirty`.

---

## Cache strategy

`global._mcpCache` keyed by `${key}:${YYYY-MM-DD-IST}`. Invalidates at midnight IST automatically. Cache key includes `mcp_session` (random UUID cookie) for per-user isolation.

Date-keyed (not fixed TTL) because NAV is published ~9–11 PM IST — a fixed TTL would either expire before NAV is out or serve stale data past midnight.

`Refresh` button passes `?force=1` / `{ force: true }` → `bustCache(key)` → fresh MCP call.
