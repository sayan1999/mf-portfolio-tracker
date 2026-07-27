import { NextRequest, NextResponse } from "next/server";
import { getCached, setCached, bustCache } from "../../../../lib/cache";

export interface GrowwStock {
  name: string;
  slug: string;
  sector: string;
  pct: number;
  fundMarketValueCr: number; // fund's absolute holding in ₹ cr
  nature: string;            // EQUITY, DEBT, CASH, etc.
}

export interface GrowwFundMeta {
  portfolioDate: string | null;  // ISO date of last SEBI disclosure
  nav: number | null;
  navDate: string | null;
  aum: number | null;            // ₹ cr
  expenseRatio: number | null;
  isin: string | null;
  subCategory: string | null;
}

export interface GrowwFundData {
  stocks: GrowwStock[];
  meta: GrowwFundMeta;
}

const GROWW_SEARCH = "https://groww.in/v1/api/search/v3/query/global/st_p_query";
const GROWW_DETAIL = "https://groww.in/v1/api/data/mf/web/v6/scheme/search";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithRetry(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (res.status === 429 && attempt < 3) {
    const wait = 1000 * 2 ** attempt;
    await new Promise(r => setTimeout(r, wait));
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

function buildSearchQuery(name: string): string {
  // Groww search breaks when the query ends with "Fund" — strip trailing generic suffixes
  return name.replace(/\s+Fund\s*$/i, "").trim();
}

async function resolveSlug(name: string): Promise<string | null> {
  const cacheKey = `groww:slug:${name}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  const query = buildSearchQuery(name);
  const res = await fetchWithRetry(
    `${GROWW_SEARCH}?query=${encodeURIComponent(query)}&page=0&count=3&entity_type=SCHEME`
  );
  if (!res.ok) return null;
  const data = await res.json() as { data?: { content?: { search_id?: string }[] } };
  const slug = data?.data?.content?.[0]?.search_id ?? null;
  if (slug) setCached(cacheKey, slug);
  return slug;
}

type RawResponse = Record<string, unknown>;

async function fetchGrowwData(slug: string): Promise<GrowwFundData> {
  const res = await fetchWithRetry(`${GROWW_DETAIL}/${slug}`);
  if (!res.ok) return { stocks: [], meta: { portfolioDate: null, nav: null, navDate: null, aum: null, expenseRatio: null, isin: null, subCategory: null } };

  const d = await res.json() as RawResponse;
  const rawHoldings = (d.holdings ?? []) as RawResponse[];

  const stocks: GrowwStock[] = rawHoldings
    .filter(h => Number(h.corpus_per) > 0)
    .map(h => ({
      name: String(h.company_name ?? ""),
      slug: String(h.stock_search_id ?? ""),
      sector: String(h.sector_name ?? "Other"),
      pct: Number(h.corpus_per) || 0,
      fundMarketValueCr: Number(h.market_value) || 0,
      nature: String(h.nature_name ?? "OTHER"),
    }));

  const firstHolding = rawHoldings[0];
  const meta: GrowwFundMeta = {
    portfolioDate: firstHolding ? String(firstHolding.portfolio_date ?? "") || null : null,
    nav: Number(d.nav) || null,
    navDate: d.nav_date ? String(d.nav_date) : null,
    aum: Number(d.aum) || null,
    expenseRatio: parseFloat(String(d.expense_ratio ?? "")) || null,
    isin: d.isin ? String(d.isin) : null,
    subCategory: d.sub_category ? String(d.sub_category) : null,
  };

  return { stocks, meta };
}

export async function POST(req: NextRequest) {
  const { funds, force } = await req.json() as { funds: { id: string; name: string }[]; force?: boolean };

  const result: Record<string, GrowwFundData> = {};

  for (let i = 0; i < funds.length; i++) {
    const { id, name } = funds[i];
    const cacheKey = `groww:holdings:${id}`;

    if (!force) {
      const cached = getCached<GrowwFundData>(cacheKey);
      if (cached) { result[id] = cached; continue; }
    } else {
      bustCache(cacheKey);
    }

    try {
      if (i > 0) await new Promise(r => setTimeout(r, 300));
      const slug = await resolveSlug(name);
      if (!slug) {
        console.warn(`[groww-holdings] no slug found for "${name}" (id=${id})`);
        result[id] = { stocks: [], meta: { portfolioDate: null, nav: null, navDate: null, aum: null, expenseRatio: null, isin: null, subCategory: null } };
        continue;
      }

      await new Promise(r => setTimeout(r, 200));
      const data = await fetchGrowwData(slug);
      if (!data.stocks.length) console.warn(`[groww-holdings] empty stocks for "${name}" (id=${id}, slug=${slug})`);
      else console.log(`[groww-holdings] "${name}" → ${data.stocks.length} holdings (slug=${slug})`);
      setCached(cacheKey, data);
      result[id] = data;
    } catch (err) {
      console.error(`[groww-holdings] exception for "${name}" (id=${id}):`, err);
      result[id] = { stocks: [], meta: { portfolioDate: null, nav: null, navDate: null, aum: null, expenseRatio: null, isin: null, subCategory: null } };
    }
  }

  return NextResponse.json({ status: "OK", holdings: result });
}
