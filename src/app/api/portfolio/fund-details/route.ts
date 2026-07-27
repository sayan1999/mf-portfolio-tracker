import { NextRequest, NextResponse } from "next/server";
import { callTool, AuthRequiredError } from "../../../../lib/mcp-client";
import { getCached, setCached, bustCache } from "../../../../lib/cache";
import { TokenStore, TOKEN_COOKIE } from "../../../../lib/token-store";

interface StockHolding { name: string; code: string | null; sector: string; pct: number }
interface FundDetail {
  name: string; category: string;
  returns1Y: number | null; returns3Y: number | null;
  stocks: StockHolding[];
  marketCap: { name: string; value: number }[];
}

function extractCode(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/instocks\/[^/]+\/([A-Za-z0-9]+)\.(?:png|jpg|jpeg|webp)/i);
  return m ? m[1] : null;
}

function extractFundMap(raw: unknown): Record<string, FundDetail> {
  const items: unknown[] = (raw as { data?: unknown[] })?.data ?? [];
  const map: Record<string, FundDetail> = {};

  for (const item of items) {
    const it = item as Record<string, unknown>;
    const fid = String(it.fund_id);
    const d = (it.data ?? {}) as Record<string, unknown>;
    const fd = (d.fund_detail ?? {}) as Record<string, unknown>;

    // Holdings → equity stocks
    const holdBlocks = ((d.holdings as { holdings?: unknown[] })?.holdings ?? []) as Array<{ name: string; holds?: unknown[] }>;
    const eqBlock = holdBlocks.find(b => b.name === "Equity") ?? holdBlocks.find(b => b.name === "All");
    const stocks: StockHolding[] = (eqBlock?.holds ?? []).map((s: unknown) => {
      const h = s as Record<string, unknown>;
      return {
        name: String(h.name ?? ""),
        code: extractCode(h.image_url as string | undefined),
        sector: String(h.sector || "Other"),
        pct: parseFloat(String(h.perc ?? "0").replace("%", "")) || 0,
      };
    });

    // Market cap from equity asset_allocation
    const allocArr = (d.asset_allocation ?? []) as Array<Record<string, unknown>>;
    const eqAlloc = allocArr.find(a => a.name === "Equity");
    const capDist = (eqAlloc?.market_cap_distribution as { market_cap?: Array<{ name: string; value: unknown }> })?.market_cap ?? [];
    const marketCap = capDist.map(m => ({ name: m.name, value: Number(m.value) || 0 }));

    // Returns from fund_detail.returns
    const rets = (fd.returns ?? {}) as Record<string, { value?: number }>;

    map[fid] = {
      name: String(fd.name ?? fd.fund_app_short_name ?? ""),
      category: String(fd.category ?? "—"),
      returns1Y: rets["1Y"]?.value ?? null,
      returns3Y: rets["3Y"]?.value ?? null,
      stocks,
      marketCap,
    };
  }
  return map;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function POST(req: NextRequest) {
  const store = await TokenStore.fromCookie(req.cookies.get(TOKEN_COOKIE)?.value);
  if (!store.get().accessToken) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });

  const { ids, force } = (await req.json()) as { ids: string[]; force?: boolean };
  const chunks = chunk(ids, 10);

  try {
    const partials = await Promise.all(
      chunks.map(async (batch) => {
        const cacheKey = `mf:fd:${[...batch].sort().join(",")}`;
        if (!force) {
          const cached = getCached<Record<string, FundDetail>>(cacheKey);
          if (cached) return cached;
        } else {
          bustCache(cacheKey);
        }

        const raw = await callTool(store, "get_mf_funds_details", {
          fund_ids: batch.join(","),
          includes: ["holdings", "asset_allocation"],
        });
        const partial = extractFundMap(raw);
        setCached(cacheKey, partial);
        return partial;
      })
    );

    const fundMap = Object.assign({}, ...partials);
    const res = NextResponse.json({ status: "OK", fundMap });
    if (store.isDirty) {
      const { value, options } = await store.toCookieOptions();
      res.cookies.set(TOKEN_COOKIE, value, options as Parameters<typeof res.cookies.set>[2]);
    }
    return res;
  } catch (err) {
    if (err instanceof AuthRequiredError) return NextResponse.json({ status: "AUTH_REQUIRED" }, { status: 401 });
    return NextResponse.json({ status: "ERROR", message: String(err) }, { status: 500 });
  }
}
