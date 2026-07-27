import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getSession, setSession } from "./session-store";
import { getBaseUrl } from "./base-url";

export interface AuthProvider extends OAuthClientProvider {
  readonly capturedAuthUrl: string | null;
}

export function buildAuthProvider(sessionId: string): AuthProvider {
  const cell = { authUrl: null as string | null };
  const BASE_URL = getBaseUrl();
  const REDIRECT_URI = `${BASE_URL}/api/mcp/callback`;

  return {
    get capturedAuthUrl() {
      return cell.authUrl;
    },

    get redirectUrl() {
      return REDIRECT_URI;
    },

    get clientMetadata() {
      return {
        client_name: "Portfolio Tracker",
        redirect_uris: [REDIRECT_URI],
      };
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      const s = getSession(sessionId);
      return s.clientInfo as OAuthClientInformationFull | undefined;
    },

    saveClientInformation(info: OAuthClientInformationMixed) {
      setSession(sessionId, { clientInfo: info });
    },

    tokens(): OAuthTokens | undefined {
      const s = getSession(sessionId);
      if (!s.accessToken) return undefined;
      return {
        access_token: s.accessToken as string,
        token_type: "Bearer",
        ...(s.refreshToken ? { refresh_token: s.refreshToken as string } : {}),
        ...(s.expiresAt
          ? { expires_in: Math.floor(((s.expiresAt as number) - Date.now()) / 1000) }
          : {}),
      };
    },

    saveTokens(tokens: OAuthTokens) {
      setSession(sessionId, {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in
          ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
          : {}),
      });
    },

    redirectToAuthorization(url: URL) {
      // Server-side: capture URL instead of actually redirecting
      cell.authUrl = url.toString();
    },

    saveCodeVerifier(v: string) {
      setSession(sessionId, { codeVerifier: v });
    },

    codeVerifier(): string {
      return getSession(sessionId).codeVerifier as string;
    },
  };
}
