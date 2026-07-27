# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Companion 

Update below docs on any architecture change if applicable.

- [`auth.md`](./auth.md) — OAuth sign-in flow, token failure cases, encrypted cookie storage, cache strategy
    @auth.md    
- [`charts.md`](./charts.md) — what MCP data is fetched, and per-chart data source breakdown
    @charts.md

**Keep these up to date.** When making changes to auth flow, token storage, caching, or any chart/data-fetch logic, update the relevant doc if the change is meaningful enough to affect how a reader would understand the system.

## Commands

```bash
npm run dev        # start dev server, always forced to port 3000 via -p 3000
npm run build      # production build (runs tsc + next build)
npx tsc --noEmit   # type-check only
```

The dev script is `next dev -p 3000` — the port is pinned because Next.js falsely detects port conflicts in this environment.

## Architecture

**Next.js 15 App Router** with all MCP calls server-side. The browser never touches the MCP server or any auth credentials directly.

### Auth flow (`src/app/api/mcp/connect/`)

- `GET /api/mcp/connect` — silent session check (decrypts `mcp_token` cookie only, no MCP call). Returns `CONNECTED` or `NOT_CONNECTED`. Called on page mount.
- `POST /api/mcp/connect` — initiates OAuth 2.1 + PKCE handshake with `mcp.indmoney.com`. Returns `AUTH_REQUIRED + authUrl` if no token, `CONNECTED + tools[]` if token valid.
- `GET /api/mcp/callback` — receives OAuth `?code=`, calls `transport.finishAuth(code)` to exchange for tokens, writes encrypted `mcp_token` cookie, redirects to `/auth-done`.
- `/auth-done` page — sets `localStorage.mcp_auth_done` then `window.close()`. The original tab listens via `storage` event and calls `verifyAfterAuth()`.

**Critical popup pattern**: `window.open("about:blank")` must fire synchronously inside the click handler (user gesture), then the async fetch resolves and sets `popup.location.href = authUrl`. Calling `window.open` after an `await` is blocked by the browser popup blocker.

### Token storage (`src/lib/token-store.ts` + `src/lib/cookie-crypto.ts`)

Tokens are stored in an AES-GCM encrypted httpOnly cookie (`mcp_token`) — **not** in server memory. This means:
- Server restarts / Vercel cold starts do not force re-authentication
- Tokens survive across tabs (cookies are shared by the browser)
- Even if the cookie is stolen, the attacker cannot extract the raw INDmoney token without `COOKIE_SECRET`

`TokenStore` is created per-request from the cookie value, mutated by the auth provider, and written back to the response if dirty (`store.isDirty`). All route handlers follow this pattern.

`cookie-crypto.ts` uses Web Crypto (AES-GCM, 256-bit key derived via SHA-256 from `COOKIE_SECRET`). IV is random per encrypt call, prepended to the ciphertext.

### Session & cache (`src/lib/`)

- `token-store.ts` — per-request `TokenStore` class backed by encrypted `mcp_token` cookie. Stores `clientInfo`, `accessToken`, `refreshToken`, `codeVerifier`, `expiresAt`.
- `cache.ts` — `global._mcpCache` Map keyed by `${cacheKey}:${YYYY-MM-DD-IST}`. Auto-invalidates at midnight IST. Cache keys use `mcp_session` cookie value (random UUID) as user namespace. Portfolio data cached here.
- `mcp-client.ts` — `callTool(store, toolName, args)` shared helper. Handles pre-flight expiry check, `AuthRequiredError` on 401, and INDmoney's double-JSON wrapping (`{ result: "...json..." }`).

### Base URL (`src/lib/base-url.ts`)

`getBaseUrl(req?)` derives the OAuth redirect URI from the **incoming request's `Host` header** — works automatically for localhost, LAN IP, Vercel, and custom domains without any env var. Falls back to `VERCEL_URL` or `NEXT_PUBLIC_BASE_URL` only when called without a request object (e.g. from `mcp-client.ts`).

### Portfolio data routes (`src/app/api/portfolio/`)

- `GET /api/portfolio/holdings` — calls `networth_holdings` (asset_type MF), caches by `mf:holdings:<sessionId>`. `?force=1` busts cache.
- `POST /api/portfolio/fund-details` `{ ids, force }` — chunks IDs into ≤10 (API limit), calls `get_mf_funds_details` with `includes: ["holdings","asset_allocation"]`, server-side extracts only needed fields (stocks, marketCap, category, returns), caches per sorted batch. Raw response is ~240KB per 10 funds — client only receives the compact extracted map.

### Dashboard page (`src/app/page.tsx`)

Single "use client" component. State-driven with Chart.js managed via `useRef<Record<string, Chart>>` — destroy + recreate on data change. Key patterns:

- `filterHoldings()` + `buildShortLabels()` run in render (not memoised) — dataset is small.
- Four `useEffect` hooks each own one chart (asset donut, cap donut, sector stacked bar, top-holdings stacked bar). Dependency arrays use serialised holding IDs to avoid deep-compare.
- Overview cards, ticker, overlap, and table rows are HTML strings set via `dangerouslySetInnerHTML` (avoids chart re-renders on sort/filter).
- `sortedRows` sort happens in render from `tableRows` state; `toggleSort` just flips `sortKey`/`sortDir` state.
- Status text uses a relative "ago" format (just now / N min ago / N hr ago), updated every 30s via `setInterval`.

### SIP Projection Calculator (`src/app/page.tsx` + `src/data/sip.json`)

Pure client-side calculator rendered at the bottom of the dashboard. No API calls — all computation is in-browser.

**Data source (`src/data/sip.json`)**: Simple `{ "Fund Name": amount }` key-value map of ongoing SIPs. Cap type (large/mid/small/flexi/gold) is inferred from the fund name at module load.

**Rate model**:
- `CapType = "large" | "mid" | "small"` — the three tunable rate knobs shown in the UI.
- `SipCapType = CapType | "flexi" | "gold"` — fund classification; flexi and gold have no separate UI knob.
- `blendedRate(marketCap, rates)` — for equity funds, applies large/mid/small rates weighted by the fund's actual stock-level market-cap breakdown (from `fundMap`). This means moving the Large Cap slider affects Parag Parikh's rate proportionally to its large-cap stock weight.
- `fallbackRate(cap, rates)` — used before `fundMap` loads: flexi falls back to `0.5×large + 0.35×mid + 0.15×small`; gold uses the gold rate directly.
- Gold ETFs never go through `blendedRate` — their `marketCap` array contains no equity segments.

**Holding match (`findHolding`)**: Strips noise words (`direct`, `etf`, `fof`, `fund`, `cap`, etc.), then matches a SIP entry to `allHoldings` if ≥2 meaningful words appear in the holding name. Handles abbreviations like "Pru" vs "Prudential" — as long as ≥2 other words match.

**Corpus formula**:
- `sipCorpus(monthly, years, rate, stepUp)` — iterative step-up SIP: each year's monthly amount is `P × (1+stepUp/100)^year`, compounded monthly.
- `growCorpus(currentValue, years, rate)` — simple annual compounding of the existing holding market value.
- Total at year N = `growCorpus(existingValue, N, rate) + sipCorpus(monthly, N, rate, stepUp)`.

**UI knobs**: Large / Mid / Small / Gold rate sliders (with historical con/opt reference bands), annual step-up slider (0–25%), custom horizon slider (1–40Y). Fixed columns: 5, 10, 15, 20, 30Y. Custom year highlighted in amber (✦).

### Favicon (`src/app/icon.svg`)

SVG favicon placed in the App Router `src/app/` directory — Next.js auto-serves it as the browser tab icon. Dark background (`#0A0D12`) with three rising bars (blue/green/faded blue) and an amber trend line, matching the dashboard colour palette. No `public/` folder needed; do not add a separate `favicon.ico` as it would conflict.

### MCP server

`https://mcp.indmoney.com/mcp` — hardcoded in all route files. **Do not move to env var** (user preference).

### Env vars

- `COOKIE_SECRET` — required. 32-byte hex string used to AES-GCM encrypt the `mcp_token` cookie. Set in `.env.local` for local dev, and in Vercel environment variables for production. Losing or rotating this key invalidates all existing sessions.
- `NEXT_PUBLIC_BASE_URL` — optional. Only used as fallback when `getBaseUrl()` is called without a request. Not needed for normal operation.
- `VERCEL_URL` — auto-injected by Vercel, used as secondary fallback in `getBaseUrl()`.
