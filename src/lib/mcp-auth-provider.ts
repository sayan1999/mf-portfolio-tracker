import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TokenStore } from "./token-store";
import { getBaseUrl } from "./base-url";
import type { NextRequest } from "next/server";

export interface AuthProvider extends OAuthClientProvider {
  readonly capturedAuthUrl: string | null;
}

export function buildAuthProvider(store: TokenStore, req?: NextRequest): AuthProvider {
  const cell = { authUrl: null as string | null };
  const BASE_URL = getBaseUrl(req);
  const REDIRECT_URI = `${BASE_URL}/api/mcp/callback`;

  return {
    get capturedAuthUrl() { return cell.authUrl; },
    get redirectUrl() { return REDIRECT_URI; },
    get clientMetadata() {
      return { client_name: "Portfolio Tracker", redirect_uris: [REDIRECT_URI] };
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      return store.get().clientInfo as OAuthClientInformationFull | undefined;
    },
    saveClientInformation(info: OAuthClientInformationMixed) {
      store.patch({ clientInfo: info as object });
    },

    tokens(): OAuthTokens | undefined {
      const d = store.get();
      if (!d.accessToken) return undefined;
      return {
        access_token: d.accessToken,
        token_type: "Bearer",
        ...(d.refreshToken ? { refresh_token: d.refreshToken } : {}),
        ...(d.expiresAt ? { expires_in: Math.floor((d.expiresAt - Date.now()) / 1000) } : {}),
      };
    },
    saveTokens(tokens: OAuthTokens) {
      store.patch({
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
      });
    },

    redirectToAuthorization(url: URL) { cell.authUrl = url.toString(); },
    saveCodeVerifier(v: string) { store.patch({ codeVerifier: v }); },
    codeVerifier(): string { return store.get().codeVerifier as string; },
  };
}
