import { encrypt, decrypt } from "./cookie-crypto";

export interface TokenData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientInfo?: object;
  codeVerifier?: string;
}

export const TOKEN_COOKIE = "mcp_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret(): string {
  const s = process.env.COOKIE_SECRET;
  if (!s) throw new Error("COOKIE_SECRET env var is not set");
  return s;
}

export class TokenStore {
  private data: TokenData;
  private _dirty = false;

  private constructor(data: TokenData) {
    this.data = data;
  }

  static async fromCookie(value: string | undefined): Promise<TokenStore> {
    if (!value) return new TokenStore({});
    try {
      const json = await decrypt(value, secret());
      return new TokenStore(JSON.parse(json) as TokenData);
    } catch {
      return new TokenStore({});
    }
  }

  get(): TokenData { return this.data; }

  patch(update: Partial<TokenData>): void {
    this.data = { ...this.data, ...update };
    this._dirty = true;
  }

  clearTokens(): void {
    const { clientInfo } = this.data;
    this.data = clientInfo ? { clientInfo } : {};
    this._dirty = true;
  }

  get isDirty(): boolean { return this._dirty; }

  async toCookieOptions(): Promise<{ value: string; options: Record<string, unknown> }> {
    return {
      value: await encrypt(JSON.stringify(this.data), secret()),
      options: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
      },
    };
  }
}
