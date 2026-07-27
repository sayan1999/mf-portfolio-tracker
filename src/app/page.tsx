"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);
import SIP_RAW from "../data/sip.json";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Holding {
  investment_code: string;
  investment: string;
  assetclass_l2: string;
  invested_amount: number;
  market_value: number;
  total_pnl: number;
  pnl_per: number;
  broker: string;
}

interface StockHolding { name: string; code: string | null; sector: string; pct: number; nature?: string; fundMarketValueCr?: number }

interface FundDetail {
  name: string; category: string;
  returns1Y: number | null; returns3Y: number | null;
  stocks: StockHolding[];
  marketCap: { name: string; value: number }[];
}

type FundMap = Record<string, FundDetail>;

interface Filters { broker: "groww" | "all"; excludeLiquidArb: boolean; excludeRegular: boolean }

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = ["#5B9DF5","#34D399","#B98CE8","#FB7185","#E8A33D","#4AD8D8","#94A3B8","#F0A868","#7ED6A8","#C084FC"];
const BIG_HOLDING_THRESHOLD = 5;
const color = (i: number) => COLORS[i % COLORS.length];

// ─── SIP Calculator constants ─────────────────────────────────────────────────

type CapType = "large" | "mid" | "small";
type SipCapType = CapType | "flexi" | "gold";

const SIP_RATE_META: Record<CapType, { label: string; min: number; max: number; con: [number,number]; opt: [number,number]; color: string }> = {
  large: { label: "Large Cap", min: 8,  max: 18, con: [11,12], opt: [12,14], color: "#5B9DF5" },
  mid:   { label: "Mid Cap",   min: 10, max: 22, con: [13,14], opt: [16,18], color: "#34D399" },
  small: { label: "Small Cap", min: 10, max: 25, con: [14,15], opt: [17,21], color: "#B98CE8" },
};

const SIP_FUNDS: { name: string; id: string; cap: SipCapType; amount: number }[] = (SIP_RAW as { name: string; id: string; amount: number }[]).map(({ name, id, amount }) => {
  const n = name.toLowerCase();
  const cap: SipCapType = n.includes("gold") ? "gold"
    : n.includes("small") || n.includes("micro") ? "small"
    : n.includes("mid") ? "mid"
    : n.includes("large") ? "large"
    : "flexi";
  return { name, id, cap, amount };
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function inr(n: number): string {
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  if (n >= 1e7) return sign + "₹" + (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return sign + "₹" + (n / 1e5).toFixed(2) + " L";
  if (n >= 1e3) return sign + "₹" + (n / 1e3).toFixed(1) + " K";
  return sign + "₹" + n.toFixed(0);
}

function inrFull(n: number): string {
  n = Math.round(n || 0);
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  let s = String(n);
  let last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  if (rest) last3 = "," + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return sign + "₹" + rest + last3;
}

function isLiquidOrArb(h: Holding): boolean {
  const n = h.investment.toLowerCase();
  const cls = h.assetclass_l2.toLowerCase();
  return cls === "liquid" || n.includes("arbitrage") || n.includes("liquid");
}

function isDirect(name: string): boolean {
  return name.toLowerCase().includes("direct");
}

function filterHoldings(holdings: Holding[], f: Filters): Holding[] {
  return holdings.filter(h => {
    if (f.broker === "groww" && h.broker.toLowerCase() !== "groww") return false;
    if (f.excludeLiquidArb && isLiquidOrArb(h)) return false;
    if (f.excludeRegular && !isDirect(h.investment)) return false;
    return true;
  });
}

function buildShortLabels(holdings: Holding[]): Record<string, string> {
  const words: Record<string, string[]> = {};
  holdings.forEach(h => { words[h.investment_code] = h.investment.trim().split(/\s+/); });
  const maxWords = Math.max(4, ...Object.values(words).map(w => w.length));
  let n = 4, labels: Record<string, string> = {};
  while (n <= maxWords) {
    labels = {};
    holdings.forEach(h => { labels[h.investment_code] = words[h.investment_code].slice(0, n).join(" "); });
    const counts: Record<string, number> = {};
    Object.values(labels).forEach(l => { counts[l] = (counts[l] || 0) + 1; });
    if (!Object.values(labels).some(l => counts[l] > 1)) break;
    n++;
  }
  const counts2: Record<string, number> = {};
  Object.values(labels).forEach(l => { counts2[l] = (counts2[l] || 0) + 1; });
  holdings.forEach(h => {
    if (counts2[labels[h.investment_code]] > 1) labels[h.investment_code] = `${labels[h.investment_code]} (#${h.investment_code})`;
  });
  return labels;
}

// ─── SIP helpers ─────────────────────────────────────────────────────────────

function blendedRate(marketCap: { name: string; value: number }[], rates: Record<CapType | "gold", number>): number {
  let weighted = 0, total = 0;
  const midpoint = (rates.large + rates.mid + rates.small) / 3;
  marketCap.forEach(mc => {
    const n = mc.name.toLowerCase();
    const r = n.includes("large") ? rates.large : n.includes("mid") ? rates.mid : (n.includes("small") || n.includes("micro")) ? rates.small : midpoint;
    weighted += mc.value * r; total += mc.value;
  });
  return total > 0 ? weighted / total : midpoint;
}

function fallbackRate(cap: SipCapType, rates: Record<CapType | "gold", number>): number {
  if (cap === "flexi") return rates.large * 0.5 + rates.mid * 0.35 + rates.small * 0.15;
  if (cap === "gold") return rates.gold;
  return rates[cap];
}

function findHolding(sipName: string, holdings: Holding[]): Holding | undefined {
  const SKIP = /\b(direct|growth|plan|fund|fof|etf|of|the|and|cap)\b/gi;
  const words = sipName.toLowerCase().replace(SKIP, "").split(/\s+/).filter(w => w.length > 2);
  return holdings.find(h => {
    const hn = h.investment.toLowerCase();
    return words.filter(w => hn.includes(w)).length >= Math.min(2, words.length);
  });
}

function growCorpus(currentValue: number, years: number, annualRate: number): number {
  return currentValue * Math.pow(1 + annualRate / 100, years);
}

function sipCorpus(monthly: number, years: number, annualRate: number, stepUpPct: number): number {
  const r = annualRate / 100 / 12;
  let corpus = 0, p = monthly;
  for (let y = 0; y < years; y++) {
    for (let m = 0; m < 12; m++) corpus = (corpus + p) * (1 + r);
    p *= (1 + stepUpPct / 100);
  }
  return corpus;
}

function sipInvested(monthly: number, years: number, stepUpPct: number): number {
  let total = 0, p = monthly;
  for (let y = 0; y < years; y++) { total += p * 12; p *= (1 + stepUpPct / 100); }
  return total;
}

function CapMixBar({ marketCap, monthly }: { marketCap: { name: string; value: number }[]; monthly: number }) {
  const segs: { key: string; pct: number; color: string; label: string }[] = [];
  let otherPct = 0;
  marketCap.forEach(mc => {
    const n = mc.name.toLowerCase();
    if (n.includes("large"))                          segs.push({ key: "large", pct: mc.value, color: "#5B9DF5", label: "L" });
    else if (n.includes("mid"))                       segs.push({ key: "mid",   pct: mc.value, color: "#34D399", label: "M" });
    else if (n.includes("small") || n.includes("micro")) segs.push({ key: "small", pct: mc.value, color: "#B98CE8", label: "S" });
    else otherPct += mc.value;
  });
  const totalPct = segs.reduce((s, g) => s + g.pct, 0) + otherPct;
  const scale = totalPct > 0 ? 100 / totalPct : 1;
  return (
    <div className="cap-mix-wrap">
      <div className="cap-mix-bar">
        {segs.map(g => (
          <span key={g.key} className="cap-seg" style={{ width: (g.pct * scale) + "%", background: g.color }}
            title={`${g.key[0].toUpperCase() + g.key.slice(1)} Cap: ${(g.pct * scale).toFixed(0)}% · ${inr(monthly * g.pct * scale / 100)}/mo`} />
        ))}
        {otherPct * scale > 1 && (
          <span className="cap-seg" style={{ width: (otherPct * scale) + "%", background: "#4A5361" }} title={`Other: ${(otherPct * scale).toFixed(0)}%`} />
        )}
      </div>
      <div className="cap-mix-labels">
        {segs.map(g => <span key={g.key} style={{ color: g.color }}>{g.label} {(g.pct * scale).toFixed(0)}%</span>)}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  // Auth
  const [authState, setAuthState] = useState<"idle"|"checking"|"auth_pending"|"connected"|"error">("idle");
  const [authError, setAuthError] = useState<string | null>(null);
  // Data
  const [allHoldings, setAllHoldings] = useState<Holding[]>([]);
  const [fundMap, setFundMap] = useState<FundMap>({});
  const [fundMapLoaded, setFundMapLoaded] = useState(false);
  // Load state
  const [step1, setStep1] = useState<"idle"|"loading"|"done"|"error">("idle");
  const [step1Detail, setStep1Detail] = useState("");
  const [step2, setStep2] = useState<"idle"|"loading"|"done"|"error">("idle");
  const [step2Detail, setStep2Detail] = useState("");
  const [step3, setStep3] = useState<"idle"|"loading"|"done"|"error">("idle");
  const [step3Detail, setStep3Detail] = useState("");
  const [statusText, setStatusText] = useState("Initializing…");
  const [lastUpdatedTick, setLastUpdatedTick] = useState(0);
  const [statusLive, setStatusLive] = useState(false);
  // Filters
  const [filters, setFilters] = useState<Filters>({ broker: "groww", excludeLiquidArb: true, excludeRegular: true });
  // Table sort
  const [sortKey, setSortKey] = useState("current");
  const [sortDir, setSortDir] = useState(-1);
  // Overlay UI
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [warnMsg, setWarnMsg] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Derived for table/overlap (state so we can re-render on sort)
  const [tableRows, setTableRows] = useState<ReturnType<typeof buildTableRows>>([]);
  const [sharedHtml, setSharedHtml] = useState("");
  const [similarityHtml, setSimilarityHtml] = useState("");
  const [selectedFundCode, setSelectedFundCode] = useState<string | null>(null);
  const [tickerHtml, setTickerHtml] = useState("");
  const [overviewHtml, setOverviewHtml] = useState("");
  const [capCaptionHtml, setCapCaptionHtml] = useState("");
  const [assetCaptionHtml, setAssetCaptionHtml] = useState("");
  const [fhView, setFhView] = useState<"stocks" | "assets">("stocks");
  // SIP calculator
  const [capRates, setCapRates] = useState<Record<CapType | "gold", number>>({ large: 13, mid: 16, small: 18, gold: 9 });
  const [stepUp, setStepUp] = useState(5);
  const [sipCustomYears, setSipCustomYears] = useState(10);

  // Canvas refs
  const assetCanvasRef = useRef<HTMLCanvasElement>(null);
  const capCanvasRef = useRef<HTMLCanvasElement>(null);
  const sectorCanvasRef = useRef<HTMLCanvasElement>(null);
  const topHoldCanvasRef = useRef<HTMLCanvasElement>(null);
  const stockExpCanvasRef = useRef<HTMLCanvasElement>(null);
  const charts = useRef<Record<string, Chart>>({});
  const shortToCode = useRef<Record<string, string>>({});
  const fundHoldingsRef = useRef<HTMLDivElement>(null);

  function destroyChart(id: string) {
    charts.current[id]?.destroy();
    delete charts.current[id];
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  // Silent session check on mount — never opens a tab, never triggers OAuth
  useEffect(() => {
    setAuthState("checking");
    fetch("/api/mcp/connect", { method: "GET" })
      .then(r => r.json())
      .then(data => {
        if (data.status === "CONNECTED") setAuthState("connected");
        else setAuthState("idle");
      })
      .catch(() => setAuthState("idle"));
  }, []);

  // Called only from a user click — opens tab synchronously so popup blocker is satisfied
  const connect = useCallback(async () => {
    setAuthState("checking");
    setAuthError(null);

    // Open blank tab NOW (inside click handler = allowed by browser)
    const popup = window.open("about:blank", "_blank");

    try {
      const res = await fetch("/api/mcp/connect", { method: "POST" });
      const data = await res.json();

      if (data.status === "CONNECTED") {
        popup?.close();
        setAuthState("connected");
      } else if (data.status === "AUTH_REQUIRED") {
        if (popup) {
          popup.location.href = data.authUrl;
          setAuthState("auth_pending");
        } else {
          // Popup was blocked — fallback message
          setAuthError("Popup blocked. Please allow popups for this site and try again.");
          setAuthState("error");
        }
      } else {
        popup?.close();
        setAuthError(data.message ?? "Connection failed");
        setAuthState("error");
      }
    } catch (e) {
      popup?.close();
      setAuthError(e instanceof Error ? e.message : String(e));
      setAuthState("error");
    }
  }, []);

  // Called after storage event (no tab needed — auth is already done, just verify)
  const verifyAfterAuth = useCallback(async () => {
    setAuthState("checking");
    try {
      const res = await fetch("/api/mcp/connect", { method: "POST" });
      const data = await res.json();
      if (data.status === "CONNECTED") setAuthState("connected");
      else { setAuthError("Session not found after login. Please try again."); setAuthState("error"); }
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
      setAuthState("error");
    }
  }, []);

  // Listen for auth-done signal from the login tab
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== "mcp_auth_done") return;
      localStorage.removeItem("mcp_auth_done");
      if (e.newValue === "ok") verifyAfterAuth();
      else { setAuthError(`Auth failed: ${e.newValue}`); setAuthState("error"); }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [verifyAfterAuth]);

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadData = useCallback(async (force = false) => {
    setErrMsg(null);
    setWarnMsg(null);
    setFundMapLoaded(false);
    setFundMap({});
    setStep1("loading");
    setStep1Detail("");
    setStep2("idle");
    setStep2Detail("");
    setStep3("idle");
    setStep3Detail("");
    setStatusLive(false);
    setStatusText("Fetching holdings…");

    try {
      const hRes = await fetch(`/api/portfolio/holdings${force ? "?force=1" : ""}`);
      if (hRes.status === 401) { connect(); return; }
      const hData = await hRes.json();
      if (hData.status !== "OK") throw new Error(hData.message ?? "Holdings fetch failed");

      const holdings: Holding[] = hData.holdings;
      setAllHoldings(holdings);
      setStep1("done");
      setStep1Detail(`${holdings.length} funds`);

      const ids = holdings.map(h => h.investment_code).filter(Boolean);
      setStep2("loading");
      setStep2Detail(`0/${ids.length}`);
      setStatusText(`Fetching fund details for ${ids.length} funds…`);

      const fdRes = await fetch("/api/portfolio/fund-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, force }),
      });
      if (fdRes.status === 401) { connect(); return; }
      const fdData = await fdRes.json();
      if (fdData.status !== "OK") throw new Error(fdData.message ?? "Fund detail fetch failed");

      // Strip INDmoney stock holdings — Groww is the sole source for stocks
      const baseFundMap: FundMap = Object.fromEntries(
        Object.entries(fdData.fundMap as FundMap).map(([id, fd]) => [id, { ...fd, stocks: [] }])
      );
      setStep2("done");
      setStep2Detail(`${ids.length}/${ids.length}`);

      // Step 3: Groww full holdings — charts only render after this completes
      setStep3("loading");
      setStatusText("Fetching complete holdings from Groww…");
      let mergedFundMap = baseFundMap;
      try {
        const funds = holdings.map(h => ({ id: h.investment_code, name: baseFundMap[h.investment_code]?.name ?? h.investment }));
        const gwRes = await fetch("/api/portfolio/groww-holdings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funds, force }),
        });
        if (gwRes.ok) {
          const gwData = await gwRes.json() as { status: string; holdings: Record<string, { stocks: { name: string; slug: string; sector: string; pct: number; nature: string; fundMarketValueCr: number }[] }> };
          if (gwData.status === "OK") {
            const next = { ...baseFundMap };
            for (const [id, fd] of Object.entries(gwData.holdings)) {
              if (next[id]) {
                next[id] = { ...next[id], stocks: fd.stocks.map(g => ({ name: g.name, code: g.slug, sector: g.sector, pct: g.pct, nature: g.nature, fundMarketValueCr: g.fundMarketValueCr })) };
              }
            }
            mergedFundMap = next;
            const matched = Object.values(gwData.holdings).filter(fd => fd.stocks.length > 0).length;
            setStep3("done");
            setStep3Detail(`${matched}/${funds.length} funds`);
          } else {
            setStep3("error");
          }
        } else {
          setStep3("error");
        }
      } catch {
        setStep3("error");
      }

      // Set fundMap and unlock charts in one go — Groww data already merged
      setFundMap(mergedFundMap);
      setFundMapLoaded(true);

      const now = new Date();
      setLastUpdated(now);
      setLastUpdatedTick(Date.now());
      setStatusLive(true);
    } catch (e) {
      setStep1(s => s === "loading" ? "error" : s);
      setStep2(s => s === "loading" ? "error" : s);
      setStep3(s => s === "loading" ? "error" : s);
      setErrMsg((e instanceof Error ? e.message : String(e)));
      setStatusText("Error");
    }
  }, [connect]);

  // Load data when connected
  useEffect(() => {
    if (authState === "connected") loadData();
  }, [authState, loadData]);

  // ── Derived state ───────────────────────────────────────────────────────────

  const filtered = filterHoldings(allHoldings, filters);
  const shortLabels = buildShortLabels(filtered);
  const totalCurrent = filtered.reduce((s, h) => s + h.market_value, 0);

  // ── Chart rendering ─────────────────────────────────────────────────────────

  // Asset allocation donut
  useEffect(() => {
    if (!assetCanvasRef.current || !filtered.length || !totalCurrent) return;
    const byClass: Record<string, number> = {};
    filtered.forEach(h => { byClass[h.assetclass_l2] = (byClass[h.assetclass_l2] || 0) + h.market_value; });
    const labels = Object.keys(byClass);
    const values = labels.map(l => byClass[l] / totalCurrent * 100);
    const colors = labels.map((_, i) => color(i));

    destroyChart("asset");
    charts.current["asset"] = new Chart(assetCanvasRef.current!, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#12161D", borderWidth: 2 }] },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: "#E7EBF0", font: { size: 11.5 }, boxWidth: 11, padding: 10 } },
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${Number(c.raw).toFixed(2)}% · ${inr(Number(c.raw) / 100 * totalCurrent)}` } }
        },
        cutout: "62%",
      },
    });

    setAssetCaptionHtml(labels.map((l, i) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:16px;white-space:nowrap;">
        <span style="width:8px;height:8px;border-radius:2px;background:${colors[i]};display:inline-block;"></span>
        ${l}&nbsp;<b style="color:#E7EBF0;font-family:monospace">${values[i].toFixed(1)}%</b>
      </span>`
    ).join(""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.map(h => h.investment_code + h.market_value).join(",")]);

  // Market cap donut
  useEffect(() => {
    if (!capCanvasRef.current || !filtered.length || !fundMapLoaded) return;
    const capTotals: Record<string, number> = {};
    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      if (!fd?.marketCap?.length) return;
      fd.marketCap.forEach(mc => {
        const contrib = (mc.value / 100) * h.market_value;
        capTotals[mc.name] = (capTotals[mc.name] || 0) + contrib;
      });
    });
    const capSum = Object.values(capTotals).reduce((a, b) => a + b, 0) || 1;
    const labels = Object.keys(capTotals);
    const values = labels.map(l => capTotals[l] / capSum * 100);
    const colors = labels.map((_, i) => color(i + 3));

    destroyChart("cap");
    charts.current["cap"] = new Chart(capCanvasRef.current!, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#12161D", borderWidth: 2 }] },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: "#E7EBF0", font: { size: 11.5 }, boxWidth: 11, padding: 10 } },
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${Number(c.raw).toFixed(2)}% · ${inr(Number(c.raw) / 100 * totalCurrent)}` } }
        },
        cutout: "62%",
      },
    });

    setCapCaptionHtml(labels.map((l, i) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:16px;white-space:nowrap;">
        <span style="width:8px;height:8px;border-radius:2px;background:${colors[i]};display:inline-block;"></span>
        ${l}&nbsp;<b style="color:#E7EBF0;font-family:monospace">${values[i].toFixed(1)}%</b>
      </span>`
    ).join(""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundMapLoaded, filtered.map(h => h.investment_code).join(","), fundMap]);

  // Sector exposure stacked bar
  useEffect(() => {
    if (!sectorCanvasRef.current || !filtered.length || !fundMapLoaded) return;
    const sectorTotals: Record<string, number> = {};
    const fundSectors: Record<string, Record<string, number>> = {};
    const fundOrder: string[] = [];

    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      if (!fd?.stocks?.length) return;
      const wt = totalCurrent ? h.market_value / totalCurrent : 0;
      const short = shortLabels[h.investment_code];
      if (!fundSectors[short]) { fundSectors[short] = {}; fundOrder.push(short); }
      fd.stocks.filter(s => !s.nature || s.nature === "EQUITY").forEach(s => {
        const pp = s.pct * wt;
        fundSectors[short][s.sector] = (fundSectors[short][s.sector] || 0) + pp;
        sectorTotals[s.sector] = (sectorTotals[s.sector] || 0) + pp;
      });
    });

    const sectors = Object.entries(sectorTotals).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const funds = [...new Set(fundOrder)];
    if (!sectors.length) return;

    const datasets = funds.map((f, i) => ({
      label: f,
      data: sectors.map(sec => +((fundSectors[f]?.[sec] || 0).toFixed(3))),
      backgroundColor: color(i),
    }));

    destroyChart("sector");
    charts.current["sector"] = new Chart(sectorCanvasRef.current!, {
      type: "bar",
      data: { labels: sectors, datasets },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, ticks: { color: "#7C8797", autoSkip: false, maxRotation: 40, minRotation: 40, font: { size: 10.5 } }, grid: { display: false } },
          y: { stacked: true, ticks: { color: "#7C8797", callback: (v) => v + "%" }, grid: { color: "#1B212B" } },
        },
        plugins: {
          legend: { labels: { color: "#E7EBF0", font: { size: 10.5 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${Number(c.raw).toFixed(2)}% · ${inr(Number(c.raw) / 100 * totalCurrent)}` } },
        },
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundMapLoaded, filtered.map(h => h.investment_code).join(","), fundMap]);

  // Top holdings per fund stacked bar
  useEffect(() => {
    if (!topHoldCanvasRef.current || !filtered.length || !fundMapLoaded) return;

    const perFund: Record<string, { label: string; pctOfAUM: number; pctOfFund: number }[]> = {};
    const segMeta: Record<string, Record<string, number>> = {};
    const fundPctMap: Record<string, number> = {};
    const funds: string[] = [];

    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      const short = shortLabels[h.investment_code];
      shortToCode.current[short] = h.investment_code;
      const fundPct = totalCurrent ? h.market_value / totalCurrent * 100 : 0;
      funds.push(short);
      fundPctMap[short] = fundPct;
      segMeta[short] = {};

      const stocks = fd?.stocks || [];
      const big = stocks.filter(s => s.pct >= BIG_HOLDING_THRESHOLD).sort((a, b) => b.pct - a.pct);
      const bigSum = big.reduce((s, x) => s + x.pct, 0);
      const others = Math.max(0, 100 - bigSum);
      const segs = big.map(s => ({ label: s.name, pctOfAUM: s.pct / 100 * fundPct, pctOfFund: s.pct }));
      if (others > 0.01) segs.push({ label: "Others", pctOfAUM: others / 100 * fundPct, pctOfFund: others });
      segs.forEach(seg => { segMeta[short][seg.label] = seg.pctOfFund; });
      perFund[short] = segs;
    });

    const uniqueFunds = [...new Set(funds)];
    const labelMax = new Map<string, number>();
    uniqueFunds.forEach(f => perFund[f].forEach(seg => {
      if (seg.label !== "Others") labelMax.set(seg.label, Math.max(labelMax.get(seg.label) || 0, seg.pctOfAUM));
    }));
    const stockOrder = [...labelMax.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const allLabels = [...stockOrder, "Others"];

    const datasets = allLabels.map((label, i) => ({
      label,
      data: uniqueFunds.map(f => +((perFund[f]?.find(s => s.label === label)?.pctOfAUM) || 0).toFixed(2)),
      backgroundColor: label === "Others" ? "#3A4250" : color(i),
    }));

    destroyChart("tophold");
    charts.current["tophold"] = new Chart(topHoldCanvasRef.current!, {
      type: "bar",
      data: { labels: uniqueFunds, datasets },
      options: {
        maintainAspectRatio: false,
        onHover: (_e, els) => { topHoldCanvasRef.current!.style.cursor = els.length ? "pointer" : "default"; },
        onClick: (_e, els) => {
          if (!els.length) return;
          const label = uniqueFunds[els[0].index];
          const code = shortToCode.current[label];
          if (!code) return;
          setSelectedFundCode(c => c === code ? null : code);
          setTimeout(() => fundHoldingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
        },
        scales: {
          x: { stacked: true, ticks: { color: "#7C8797", maxRotation: 30, minRotation: 30, font: { size: 10.5 } }, grid: { display: false } },
          y: { stacked: true, ticks: { color: "#7C8797", callback: (v) => v + "%" }, title: { display: true, text: "% of AUM", color: "#7C8797" }, grid: { color: "#1B212B" } },
        },
        plugins: {
          legend: { labels: { color: "#E7EBF0", font: { size: 10.5 }, boxWidth: 10 } },
          tooltip: {
            callbacks: {
              label: (c) => {
                const fund = c.label;
                const pof = fund && c.dataset.label ? segMeta[fund]?.[c.dataset.label] : undefined;
                const aumAbs = inr(Number(c.raw) / 100 * totalCurrent);
                return pof != null
                  ? ` ${c.dataset.label}: ${pof.toFixed(1)}% of fund · ${Number(c.raw).toFixed(2)}% of AUM (${aumAbs})`
                  : ` ${c.dataset.label}: ${Number(c.raw).toFixed(2)}% of AUM (${aumAbs})`;
              },
              footer: (items) => {
                const f = items[0]?.label;
                return f ? `Fund total: ${(fundPctMap[f] || 0).toFixed(2)}% of AUM` : "";
              },
            },
          },
        },
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundMapLoaded, filtered.map(h => h.investment_code).join(","), fundMap]);

  // Stock exposure chart (consolidated across all funds)
  useEffect(() => {
    if (!stockExpCanvasRef.current || !filtered.length || !fundMapLoaded) return;
    const stockTotals: Record<string, { pct: number; val: number }> = {};
    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      if (!fd?.stocks?.length) return;
      const fundWeight = totalCurrent ? h.market_value / totalCurrent : 0;
      fd.stocks.filter(s => !s.nature || s.nature === "EQUITY").forEach(s => {
        const contrib = (s.pct / 100) * fundWeight * 100;
        const contribVal = (s.pct / 100) * h.market_value;
        if (!stockTotals[s.name]) stockTotals[s.name] = { pct: 0, val: 0 };
        stockTotals[s.name].pct += contrib;
        stockTotals[s.name].val += contribVal;
      });
    });
    const sorted = Object.entries(stockTotals).sort((a, b) => b[1].pct - a[1].pct).slice(0, 18);
    if (!sorted.length) return;
    const labels = sorted.map(([name]) => name).reverse();
    const values = sorted.map(([, v]) => +v.pct.toFixed(2)).reverse();
    const absVals = sorted.map(([, v]) => v.val).reverse();

    destroyChart("stockexp");
    charts.current["stockexp"] = new Chart(stockExpCanvasRef.current!, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: values.map((_, i) => i >= values.length - 3 ? "#5B9DF5" : "#5B9DF580"),
          borderColor: "transparent",
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => ` ${Number(c.raw).toFixed(2)}% of portfolio · ${inr(absVals[c.dataIndex])}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: "#7C8797", callback: (v) => v + "%" }, grid: { color: "#1B212B" } },
          y: { ticks: { color: "#E7EBF0", font: { size: 11.5 } }, grid: { display: false } },
        },
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundMapLoaded, filtered.map(h => h.investment_code).join(","), fundMap]);

  // Cleanup charts on unmount
  useEffect(() => () => { Object.values(charts.current).forEach(c => c.destroy()); }, []);

  // Live "ago" status text
  useEffect(() => {
    function agoText(date: Date): string {
      const secs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (secs < 60) return "just now";
      if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
      return `${Math.floor(secs / 3600)} hr ago`;
    }
    if (!lastUpdated || !statusLive) return;
    setStatusText(`Live · updated ${agoText(lastUpdated)}`);
    const id = setInterval(() => setStatusText(`Live · updated ${agoText(lastUpdated)}`), 30_000);
    return () => clearInterval(id);
  }, [lastUpdated, lastUpdatedTick, statusLive]);

  // ── Overview, table, ticker, overlap (state-driven HTML) ───────────────────

  useEffect(() => {
    if (!filtered.length) { setOverviewHtml(""); return; }
    const invested = filtered.reduce((s, h) => s + h.invested_amount, 0);
    const current = filtered.reduce((s, h) => s + h.market_value, 0);
    const gain = current - invested;
    const gainPct = invested ? gain / invested * 100 : 0;
    const cls = gain >= 0 ? "pos" : "neg";
    setOverviewHtml(`
      <div class="metric"><div class="label">Invested</div><div class="value">${inrFull(invested)}</div></div>
      <div class="metric"><div class="label">Current value</div><div class="value">${inrFull(current)}</div></div>
      <div class="metric"><div class="label">Total gain</div><div class="value ${cls}">${inrFull(gain)}</div></div>
      <div class="metric"><div class="label">Overall return</div><div class="value ${cls}">${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(2)}%</div></div>
    `);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.map(h => h.investment_code + h.market_value + h.invested_amount).join(",")]);

  useEffect(() => {
    if (!filtered.length) { setTickerHtml(""); return; }
    const items = filtered.map(h => {
      const up = h.pnl_per >= 0;
      return `<span class="tick-item"><b>${shortLabels[h.investment_code]}</b><span class="${up ? "tick-up" : "tick-down"}">${up ? "▲" : "▼"} ${Math.abs(h.pnl_per).toFixed(2)}%</span></span>`;
    });
    setTickerHtml(items.join("") + items.join(""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.map(h => h.investment_code + h.pnl_per).join(",")]);

  // Shared holdings + Fund similarity
  useEffect(() => {
    const empty = () => { setSharedHtml(""); setSimilarityHtml(""); };
    if (!fundMapLoaded || filtered.length < 2) { empty(); return; }

    const stockAlloc: Record<string, { display: string; byFund: Record<string, number> }> = {};
    const fundStockFrac: Record<string, Record<string, number>> = {};
    const fundCodes: string[] = [];

    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      if (!fd?.stocks?.length) return;
      const fc = h.investment_code;
      fundCodes.push(fc);
      fundStockFrac[fc] = fundStockFrac[fc] || {};
      fd.stocks.filter(s => !s.nature || s.nature === "EQUITY").forEach(s => {
        const key = s.code ? `c:${s.code}` : `u:${fc}:${s.name}`;
        fundStockFrac[fc][key] = (fundStockFrac[fc][key] || 0) + s.pct / 100;
        const val = s.pct / 100 * h.market_value;
        stockAlloc[key] = stockAlloc[key] || { display: s.name, byFund: {} };
        stockAlloc[key].byFund[fc] = (stockAlloc[key].byFund[fc] || 0) + val;
      });
    });

    const uniqueCodes = [...new Set(fundCodes)];
    const crossHeld = Object.entries(stockAlloc).filter(([, v]) => Object.keys(v.byFund).length >= 2);
    const crossVal = crossHeld.reduce((s, [, v]) => s + Object.values(v.byFund).reduce((a, b) => a + b, 0), 0);
    const crossPct = totalCurrent ? crossVal / totalCurrent * 100 : 0;

    if (uniqueCodes.length < 2 || !crossHeld.length) {
      setSharedHtml('<div class="empty">Not enough holdings data for the current filters</div>');
      setSimilarityHtml("");
      return;
    }

    // ── Shared holdings ──────────────────────────────────────────────────────
    const topCross = crossHeld
      .map(([, v]) => ({ stock: v.display, value: Object.values(v.byFund).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.value - a.value).slice(0, 8);
    const maxVal = topCross[0]?.value || 1;

    let sharedHtml = `<div style="margin-bottom:16px">
      <div class="metric" style="display:inline-block;min-width:220px">
        <div class="label">Cross-held exposure</div>
        <div class="value">${crossPct.toFixed(1)}%</div>
        <div class="delta">${inr(crossVal)} across stocks held by 2+ funds</div>
      </div></div>`;
    sharedHtml += topCross.map(o => {
      const pct = totalCurrent ? (o.value / totalCurrent * 100) : 0;
      return `<div class="overlap-row">
        <div class="overlap-label">${o.stock}</div>
        <div class="overlap-bar-bg"><div class="overlap-bar-fg" style="width:${(o.value / maxVal * 100).toFixed(1)}%"></div></div>
        <div class="overlap-pct">${inr(o.value)} (${pct.toFixed(1)}%)</div>
      </div>`;
    }).join("");
    setSharedHtml(sharedHtml);

    // ── Fund similarity ───────────────────────────────────────────────────────
    type PairStock = { name: string; wa: number; wb: number; ov: number };
    const pairs: { fa: string; fb: string; ov: number; stocks: PairStock[] }[] = [];
    for (let i = 0; i < uniqueCodes.length; i++) {
      for (let j = i + 1; j < uniqueCodes.length; j++) {
        const ca = uniqueCodes[i], cb = uniqueCodes[j];
        const wa = fundStockFrac[ca] || {}, wb = fundStockFrac[cb] || {};
        const common = Object.keys(wa).filter(s => wb[s] !== undefined);
        if (!common.length) continue;
        const stocks: PairStock[] = common
          .map(st => ({ name: stockAlloc[st]?.display ?? st, wa: wa[st], wb: wb[st], ov: Math.min(wa[st], wb[st]) }))
          .sort((a, b) => b.ov - a.ov);
        const ov = stocks.reduce((s, st) => s + st.ov, 0) * 100;
        if (ov > 0.5) pairs.push({ fa: shortLabels[ca], fb: shortLabels[cb], ov, stocks });
      }
    }
    pairs.sort((a, b) => b.ov - a.ov);

    setSimilarityHtml(pairs.slice(0, 10).map(p => {
      const rows = p.stocks.map(s => `
        <tr>
          <td>${s.name}</td>
          <td>${(s.wa * 100).toFixed(2)}%</td>
          <td>${(s.wb * 100).toFixed(2)}%</td>
          <td class="ov-val">${(s.ov * 100).toFixed(2)}%</td>
        </tr>`).join("");
      return `
      <div class="overlap-row">
        <div class="overlap-label">${p.fa} × ${p.fb}</div>
        <div class="overlap-bar-bg"><div class="overlap-bar-fg" style="width:${Math.min(p.ov, 100).toFixed(1)}%"></div></div>
        <div class="overlap-pct">${p.ov.toFixed(1)}%</div>
        <details>
          <summary>${p.stocks.length} common stocks</summary>
          <div class="overlap-breakdown">
            <table>
              <thead><tr><th>Stock</th><th>${p.fa}</th><th>${p.fb}</th><th>Overlap</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </details>
      </div>`;
    }).join(""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundMapLoaded, filtered.map(h => h.investment_code).join(","), fundMap]);

  // Table rows
  useEffect(() => {
    setTableRows(buildTableRows(filtered, fundMap, totalCurrent));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.map(h => h.investment_code + h.market_value).join(","), fundMap]);

  // ── Table ───────────────────────────────────────────────────────────────────

  const sortedRows = [...tableRows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[sortKey] as number ?? 0;
    const bv = (b as Record<string, unknown>)[sortKey] as number ?? 0;
    return (av > bv ? 1 : -1) * sortDir;
  });

  function toggleSort(key: string) {
    setSortDir(sortKey === key ? -sortDir : -1);
    setSortKey(key);
  }

  const colDefs = [
    { k: "name",    label: "Fund",     num: false },
    { k: "cat",     label: "Category", num: false },
    { k: "broker",  label: "Broker",   num: false },
    { k: "r1y",     label: "1Y%",      num: true  },
    { k: "r3y",     label: "3Y%",      num: true  },
    { k: "invested",label: "Invested", num: true  },
    { k: "current", label: "Current",  num: true  },
    { k: "pnl",     label: "P&L%",     num: true  },
    { k: "weight",  label: "Weight",   num: true  },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  if (authState !== "connected") {
    return (
      <>
        <div className="ticker-outer">
          <div className="ticker-track">
            <span className="tick-item">Connecting to INDmoney…</span>
          </div>
        </div>
        <div className="connect-screen">
          <div className="connect-title">Portfolio Terminal</div>
          <div className="connect-sub">Mutual fund dashboard · powered by INDmoney</div>

          {authState === "checking" && (
            <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>Checking session…</p>
          )}

          {authState === "auth_pending" && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Login tab opened — complete authentication there, this page will update automatically.
            </p>
          )}

          {(authState === "idle" || authState === "error") && (
            <>
              <p style={{ color: "var(--muted)", fontSize: 13, maxWidth: 360, textAlign: "center" }}>
                {authState === "idle"
                  ? "No active session found. Click below to log in via INDmoney."
                  : "Session expired or disconnected."}
              </p>
              <button className="btn-connect" onClick={connect}>
                Connect to INDmoney
              </button>
            </>
          )}

          {authError && <div className="connect-error">{authError}</div>}
        </div>
      </>
    );
  }

  return (
    <>
      {/* Ticker */}
      <div className="ticker-outer">
        <div className="ticker-track" dangerouslySetInnerHTML={{ __html: tickerHtml || '<span class="tick-item">Loading holdings…</span>' }} />
      </div>

      <div className="wrap">
        {/* Header */}
        <header>
          <div>
            <div className="h-title">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{marginRight:"9px",flexShrink:0}}>
                <rect x="3" y="12" width="4" height="8" rx="1" fill="#5B9DF5"/>
                <rect x="10" y="7" width="4" height="13" rx="1" fill="#34D399"/>
                <rect x="17" y="3" width="4" height="17" rx="1" fill="#5B9DF5" opacity="0.6"/>
                <path d="M4 11L11 6.5L18 3" stroke="#E8A33D" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Portfolio Terminal
              <span className="h-title-sep">|</span>
              <span className="h-title-desc">Your mutual fund dashboard</span>
            </div>
            <div className="h-sub">Powered by INDmoney MCP</div>
          </div>
          <div className="h-actions">
            <span>
              <span className={`status-dot${statusLive ? " live" : errMsg ? " err" : ""}`} />
              <span id="statusText" style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)" }}>{statusText}</span>
            </span>
            <button className="refresh" onClick={() => loadData(true)} disabled={step1 === "loading" || step2 === "loading"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={step1 === "loading" || step2 === "loading" || step3 === "loading" ? "spin" : ""}>
                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              Refresh
            </button>
          </div>
        </header>

        {/* Steps */}
        <div className="status-steps">
          <div className={`step${step1 !== "idle" ? " " + step1 : ""}`}>
            <span className="step-dot" />1. Holdings{step1Detail ? ` · ${step1Detail}` : ""}
          </div>
          <div className="step-arrow">→</div>
          <div className={`step${step2 !== "idle" ? " " + step2 : ""}`}>
            <span className="step-dot" />2. Fund details{step2Detail ? ` · ${step2Detail}` : ""}
          </div>
          <div className="step-arrow">→</div>
          <div className={`step${step3 !== "idle" ? " " + step3 : ""}`}>
            <span className="step-dot" />3. Full holdings{step3Detail ? ` · ${step3Detail}` : ""}
          </div>
        </div>

        {/* Filter bar */}
        <div className="filter-bar">
          <div className="filter-group">
            <span className="fg-label">Broker</span>
            <div className="seg">
              {(["groww", "all"] as const).map(v => (
                <button key={v} className={filters.broker === v ? "active" : ""} onClick={() => setFilters(f => ({ ...f, broker: v }))}>
                  {v === "groww" ? "Groww only" : "All brokers"}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <label className="chk">
              <input type="checkbox" checked={filters.excludeLiquidArb} onChange={e => setFilters(f => ({ ...f, excludeLiquidArb: e.target.checked }))} />
              Exclude liquid &amp; arbitrage
            </label>
          </div>
          <div className="filter-group">
            <label className="chk">
              <input type="checkbox" checked={filters.excludeRegular} onChange={e => setFilters(f => ({ ...f, excludeRegular: e.target.checked }))} />
              Exclude regular plans
            </label>
          </div>
          <div className="filter-count">{filtered.length} of {allHoldings.length} funds shown</div>
        </div>

        {/* Banners */}
        {errMsg  && <div className="err-banner">{errMsg}</div>}
        {warnMsg && <div className="warn-banner">{warnMsg}</div>}

        {/* Overview */}
        <div className="card">
          <h2>Overview</h2>
          {overviewHtml ? (
            <div className="grid-4" dangerouslySetInnerHTML={{ __html: overviewHtml }} />
          ) : (
            <div className="grid-4">
              {["Invested","Current value","Total gain","Overall return"].map(l => (
                <div key={l} className="metric">
                  <div className="label">{l}</div>
                  <div className="value skeleton sk-line" style={{ width: "70%" }} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Allocation charts */}
        <div className="grid-2">
          <div className="card">
            <h2>Allocation by asset class</h2>
            <div className="chart-box-mid">
              <canvas ref={assetCanvasRef} />
            </div>
            <div className="donut-caption" dangerouslySetInnerHTML={{ __html: assetCaptionHtml }} />
          </div>
          <div className="card">
            <h2>Equity by market cap</h2>
            <div className="chart-box-mid">
              {!fundMapLoaded && <div className="chart-box-mid skeleton" style={{ position: "absolute", inset: 0 }} />}
              <canvas ref={capCanvasRef} />
            </div>
            <div className="donut-caption" dangerouslySetInnerHTML={{ __html: capCaptionHtml }} />
          </div>
        </div>

        {/* Holdings table */}
        <div className="card">
          <h2>Funds</h2>
          {sortedRows.length === 0 ? (
            <><div className="skeleton sk-line" /><div className="skeleton sk-line" /><div className="skeleton sk-line" /></>
          ) : (
            <table>
              <thead>
                <tr>
                  {colDefs.map(c => (
                    <th key={c.k} className={c.num ? "num" : ""} onClick={() => toggleSort(c.k)}>
                      {c.label}{sortKey === c.k ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(r => {
                  const hasHoldings = !!fundMap[r.code]?.stocks?.length;
                  return (
                    <tr key={r.code} className={selectedFundCode === r.code ? "row-selected" : ""}>
                      <td
                        className={`fund-name${hasHoldings ? " fund-name-link" : ""}`}
                        title={r.name}
                        onClick={() => {
                          if (!hasHoldings) return;
                          setSelectedFundCode(c => c === r.code ? null : r.code);
                          setTimeout(() => fundHoldingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                        }}
                      >
                        {r.name}
                        {hasHoldings && <span className="fn-chevron">{selectedFundCode === r.code ? "▲" : "▼"}</span>}
                      </td>
                      <td><span className="tag">{r.cat}</span></td>
                      <td style={{ color: "var(--muted)", fontSize: 12 }}>{r.broker}</td>
                      <td className={`num ${r.r1y === null ? "" : r.r1y >= 0 ? "pos" : "neg"}`}>
                        {r.r1y === null ? "—" : `${r.r1y >= 0 ? "+" : ""}${r.r1y.toFixed(2)}%`}
                      </td>
                      <td className={`num ${r.r3y === null ? "" : r.r3y >= 0 ? "pos" : "neg"}`}>
                        {r.r3y === null ? "—" : `${r.r3y >= 0 ? "+" : ""}${r.r3y.toFixed(2)}%`}
                      </td>
                      <td className="num">{inrFull(r.invested)}</td>
                      <td className="num">{inrFull(r.current)}</td>
                      <td className={`num ${r.pnl >= 0 ? "pos" : "neg"}`}>{r.pnl >= 0 ? "+" : ""}{r.pnl.toFixed(2)}%</td>
                      <td className="num">{r.weight.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Fund holdings explorer — below the funds table */}
        {fundMapLoaded && filtered.some(h => fundMap[h.investment_code]?.stocks?.length) && (
          <div className="card" ref={fundHoldingsRef}>
            <h2>Fund holdings</h2>
            <div className="fh-pills">
              {filtered.filter(h => fundMap[h.investment_code]?.stocks?.length).map(h => (
                <button
                  key={h.investment_code}
                  className={`fh-pill${selectedFundCode === h.investment_code ? " active" : ""}`}
                  onClick={() => setSelectedFundCode(c => c === h.investment_code ? null : h.investment_code)}
                >
                  {shortLabels[h.investment_code]}
                </button>
              ))}
            </div>
            {selectedFundCode && (
              <div className="seg fh-view-seg">
                <button className={fhView === "stocks" ? "active" : ""} onClick={() => setFhView("stocks")}>Stocks</button>
                <button className={fhView === "assets" ? "active" : ""} onClick={() => setFhView("assets")}>Asset split</button>
              </div>
            )}
            {selectedFundCode && fundMap[selectedFundCode] && (() => {
              const fd = fundMap[selectedFundCode];
              const holding = filtered.find(h => h.investment_code === selectedFundCode);
              const mv = holding?.market_value ?? 0;

              if (fhView === "assets") {
                const total = fd.marketCap.reduce((s, r) => s + r.value, 0) || 100;
                const isCapRow = (n: string) => { const l = n.toLowerCase(); return l.includes("large") || l.includes("mid") || l.includes("small") || l.includes("micro"); };
                const capRows  = fd.marketCap.filter(r => isCapRow(r.name)).sort((a, b) => b.value - a.value);
                const otherRows = fd.marketCap.filter(r => !isCapRow(r.name)).sort((a, b) => b.value - a.value);
                const equityTotal = capRows.reduce((s, r) => s + r.value, 0);
                const subCapColor = (n: string) => n.toLowerCase().includes("large") ? "#5B9DF5" : n.toLowerCase().includes("mid") ? "#34D399" : "#B98CE8";
                return (
                  <div className="fh-table-wrap">
                    <table className="fh-table">
                      <thead>
                        <tr>
                          <th>Asset class</th>
                          <th className="fh-th-r">% of fund</th>
                          <th className="fh-th-r">Est. value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {capRows.length > 0 && (
                          <>
                            <tr className="fh-asset-parent">
                              <td className="fh-td-name" style={{ color: "#5B9DF5", fontWeight: 600 }}>Equity</td>
                              <td className="fh-td-r">{(equityTotal / total * 100).toFixed(1)}%</td>
                              <td className="fh-td-r fh-val">{inr(equityTotal / total * mv)}</td>
                            </tr>
                            {capRows.map(sub => (
                              <tr key={sub.name} className="fh-asset-sub">
                                <td className="fh-td-name fh-sub-indent" style={{ color: subCapColor(sub.name) }}>↳ {sub.name}</td>
                                <td className="fh-td-r">{(sub.value / total * 100).toFixed(1)}%</td>
                                <td className="fh-td-r fh-val">{inr(sub.value / total * mv)}</td>
                              </tr>
                            ))}
                          </>
                        )}
                        {otherRows.map((row, i) => (
                          <tr key={row.name} className="fh-asset-parent">
                            <td className="fh-td-name" style={{ color: COLORS[i + 3], fontWeight: 600 }}>{row.name}</td>
                            <td className="fh-td-r">{(row.value / total * 100).toFixed(1)}%</td>
                            <td className="fh-td-r fh-val">{inr(row.value / total * mv)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              }

              // Default: stocks view
              const stocks = [...fd.stocks].sort((a, b) => b.pct - a.pct);
              return (
                <div className="fh-table-wrap">
                  <table className="fh-table">
                    <thead>
                      <tr>
                        <th className="fh-th-num">#</th>
                        <th>Stock</th>
                        <th>Sector</th>
                        <th className="fh-th-r">% of fund</th>
                        <th className="fh-th-r">Est. value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stocks.map((s, i) => {
                        const isEquity = !s.nature || s.nature === "EQUITY";
                        return (
                          <tr key={i} className={isEquity ? "" : "fh-tr-nonequity"}>
                            <td className="fh-td-num">{i + 1}</td>
                            <td className="fh-td-name">
                              {s.name}
                              {!isEquity && <span className="fh-nature-badge">{s.nature}</span>}
                            </td>
                            <td className="fh-td-sector">{s.sector || "—"}</td>
                            <td className="fh-td-r">{s.pct.toFixed(2)}%</td>
                            <td className="fh-td-r fh-val">{inr(s.pct / 100 * mv)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        )}

        {/* Sector chart */}
        <div className="card">
          <h2>Sector exposure — portfolio-weighted</h2>
          <div className="chart-box-tall">
            {!fundMapLoaded && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 6 }} />}
            <canvas ref={sectorCanvasRef} />
          </div>
        </div>

        {/* Stock exposure chart */}
        <div className="card">
          <h2>Stock exposure — consolidated across funds</h2>
          <div className="chart-box-stock">
            {!fundMapLoaded && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 6 }} />}
            <canvas ref={stockExpCanvasRef} />
          </div>
          {fundMapLoaded && (
            <div className="chart-note">
              Each bar = stock&apos;s total <b>% of your portfolio</b> summed across all funds that hold it, weighted by fund allocation. Top 18 stocks shown. Full portfolio data via Groww.
            </div>
          )}
        </div>

        {/* Top holdings chart */}
        <div className="card">
          <h2>Top holdings per fund</h2>
          <div className="chart-box-tall">
            {!fundMapLoaded && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 6 }} />}
            <canvas ref={topHoldCanvasRef} />
          </div>
          {fundMapLoaded && (
            <div className="chart-note">
              Bar height = fund&apos;s <b>% of total AUM</b>. A stock gets its own color only if ≥<b>{BIG_HOLDING_THRESHOLD}%</b> of that fund. <b>Click a bar or fund name</b> in the table above to drill into holdings.
            </div>
          )}
        </div>


        {/* Shared holdings */}
        <div className="card">
          <h2>Shared holdings</h2>
          {sharedHtml ? (
            <div dangerouslySetInnerHTML={{ __html: sharedHtml }} />
          ) : (
            <><div className="skeleton sk-line" /><div className="skeleton sk-line" /></>
          )}
        </div>

        {/* Fund similarity */}
        <div className="card">
          <h2>Fund similarity</h2>
          {similarityHtml ? (
            <div dangerouslySetInnerHTML={{ __html: similarityHtml }} />
          ) : (
            <><div className="skeleton sk-line" /><div className="skeleton sk-line" /></>
          )}
        </div>

        {/* SIP Projection Calculator */}
        {(() => {
          const FIXED_YEARS = [5, 10, 15, 20, 30];
          const sipMeta = SIP_FUNDS.map(sip => {
            const holding = allHoldings.find(h => h.investment_code === sip.id);
            const fd = fundMapLoaded ? fundMap[sip.id] ?? null : null;
            const rate = fd && fd.marketCap.length > 0 ? blendedRate(fd.marketCap, capRates) : fallbackRate(sip.cap, capRates);
            return { rate, existingValue: holding?.market_value ?? 0, fd };
          });
          const totalMonthly = SIP_FUNDS.reduce((s, f) => s + f.amount, 0);
          const totalExisting = sipMeta.reduce((s, m) => s + m.existingValue, 0);
          const totalInvestedCust = SIP_FUNDS.reduce((s, f) => s + sipInvested(f.amount, sipCustomYears, stepUp), 0);
          const totalCorpusCust = SIP_FUNDS.reduce((s, f, i) => s + growCorpus(sipMeta[i].existingValue, sipCustomYears, sipMeta[i].rate) + sipCorpus(f.amount, sipCustomYears, sipMeta[i].rate, stepUp), 0);
          return (
            <div className="card sip-calc">
              <div className="sip-header">
                <h2>SIP Projection</h2>
                <div className="sip-header-meta">
                  <span className="sip-total-lbl">Total monthly</span>
                  <span className="sip-total-val">{inrFull(totalMonthly)}</span>
                </div>
              </div>

              {/* Per-cap return rate tuners */}
              <div className="sip-rates-grid">
                {([...Object.keys(SIP_RATE_META), "gold"] as (CapType | "gold")[]).map(cap => {
                  if (cap === "gold") {
                    return (
                      <div key="gold" className="sip-rate-card">
                        <div className="sip-rate-top">
                          <span className="sip-rate-name">Gold</span>
                          <span className="sip-rate-cur" style={{ color: "#E8A33D" }}>{capRates.gold?.toFixed(1) ?? "9.0"}%</span>
                        </div>
                        <input type="range" min={5} max={14} step={0.5} value={capRates.gold ?? 9}
                          onChange={e => setCapRates(prev => ({ ...prev, gold: +e.target.value }))}
                          className="sip-slider" />
                        <div className="sip-rate-refs">
                          <span className="sip-rate-con">Con 8.5%</span>
                          <span className="sip-rate-opt">Opt 9.5%</span>
                        </div>
                      </div>
                    );
                  }
                  const meta = SIP_RATE_META[cap as CapType];
                  return (
                    <div key={cap} className="sip-rate-card">
                      <div className="sip-rate-top">
                        <span className="sip-rate-name">{meta.label}</span>
                        <span className="sip-rate-cur" style={{ color: meta.color }}>{capRates[cap as CapType].toFixed(1)}%</span>
                      </div>
                      <input type="range" min={meta.min} max={meta.max} step={0.5} value={capRates[cap as CapType]}
                        onChange={e => setCapRates(prev => ({ ...prev, [cap]: +e.target.value }))}
                        className="sip-slider" />
                      <div className="sip-rate-refs">
                        <span className="sip-rate-con">Con {meta.con[0]}–{meta.con[1]}%</span>
                        <span className="sip-rate-opt">Opt {meta.opt[0]}–{meta.opt[1]}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Step-up + custom horizon knobs */}
              <div className="sip-knobs">
                <div className="sip-knob">
                  <span className="sip-knob-label">Annual step-up</span>
                  <div className="sip-knob-row">
                    <input type="range" min={0} max={25} step={1} value={stepUp}
                      onChange={e => setStepUp(+e.target.value)} className="sip-slider" />
                    <span className="sip-knob-val">{stepUp}%</span>
                  </div>
                </div>
                <div className="sip-knob">
                  <span className="sip-knob-label">Custom horizon ✦</span>
                  <div className="sip-knob-row">
                    <input type="range" min={1} max={40} step={1} value={sipCustomYears}
                      onChange={e => setSipCustomYears(+e.target.value)} className="sip-slider" />
                    <span className="sip-knob-val">{sipCustomYears}Y</span>
                  </div>
                </div>
              </div>

              {/* Projection table */}
              <div className="sip-table-wrap">
                <table className="sip-table">
                  <thead>
                    <tr>
                      <th className="sip-th-fund">Fund</th>
                      <th className="sip-th-amt">Monthly</th>
                      <th className="sip-th-amt">Current</th>
                      <th className="sip-th-mix">Cap mix</th>
                      {FIXED_YEARS.map(y => <th key={y} className="sip-th-yr">{y}Y</th>)}
                      <th className="sip-th-yr sip-th-cust">{sipCustomYears}Y ✦</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SIP_FUNDS.map((sip, i) => {
                      const { rate, existingValue, fd } = sipMeta[i];
                      const capLabel = sip.cap === "flexi" ? "Flexi Cap" : sip.cap === "gold" ? "Gold" : SIP_RATE_META[sip.cap].label;
                      const totalAtYear = (y: number) => growCorpus(existingValue, y, rate) + sipCorpus(sip.amount, y, rate, stepUp);
                      return (
                        <tr key={sip.name} className="sip-tr">
                          <td className="sip-td-fund">{sip.name}</td>
                          <td className="sip-td-amt">{inrFull(sip.amount)}</td>
                          <td className="sip-td-amt">{existingValue > 0 ? inr(existingValue) : <span style={{ color: "var(--faint)" }}>—</span>}</td>
                          <td className="sip-td-mix">
                            {fd && fd.marketCap.length > 0
                              ? <CapMixBar marketCap={fd.marketCap} monthly={sip.amount} />
                              : <span className="sip-cap-fb">{capLabel}{sip.cap === "flexi" ? " (est.)" : ""}</span>}
                            <span className="sip-blend">~{rate.toFixed(1)}%</span>
                          </td>
                          {FIXED_YEARS.map(y => (
                            <td key={y} className="sip-td-corpus">{inr(totalAtYear(y))}</td>
                          ))}
                          <td className="sip-td-corpus sip-td-cust">{inr(totalAtYear(sipCustomYears))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="sip-tr-tot">
                      <td className="sip-td-fund">Total</td>
                      <td className="sip-td-amt">{inrFull(totalMonthly)}</td>
                      <td className="sip-td-amt">{inr(totalExisting)}</td>
                      <td className="sip-td-mix" />
                      {FIXED_YEARS.map(y => (
                        <td key={y} className="sip-td-corpus">
                          {inr(SIP_FUNDS.reduce((s, f, i) => s + growCorpus(sipMeta[i].existingValue, y, sipMeta[i].rate) + sipCorpus(f.amount, y, sipMeta[i].rate, stepUp), 0))}
                        </td>
                      ))}
                      <td className="sip-td-corpus sip-td-cust">{inr(totalCorpusCust)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Summary line */}
              <div className="sip-summary">
                At <b>{sipCustomYears}Y</b> with <b>{stepUp}% step-up</b> &mdash;{" "}
                existing <b>{inr(totalExisting)}</b> + fresh SIPs <b>{inr(totalInvestedCust)}</b>{" "}
                = total in <b>{inr(totalExisting + totalInvestedCust)}</b> &nbsp;→&nbsp;
                corpus <b style={{ color: "var(--pos)" }}>{inr(totalCorpusCust)}</b>
                <span className="sip-gain-x">&nbsp;({(totalCorpusCust / (totalExisting + totalInvestedCust)).toFixed(1)}×)</span>
              </div>
            </div>
          );
        })()}

      </div>

      {/* Footer */}
      <footer className="site-footer">
        <div className="wrap footer-inner">
          <div className="footer-brand">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="28" height="28" rx="7" fill="#1B2535"/>
              <path d="M7 21V10l7-3 7 3v11" stroke="#5B9DF5" strokeWidth="1.6" strokeLinejoin="round"/>
              <path d="M11 21v-6h6v6" stroke="#34D399" strokeWidth="1.6" strokeLinejoin="round"/>
            </svg>
            <div>
              <div className="footer-brand-name">Portfolio Terminal</div>
              <div className="footer-brand-sub">Powered by INDmoney MCP</div>
            </div>
          </div>
          <div className="footer-divider" />
          <div className="footer-notes">
            {lastUpdated && (
              <div className="footer-timestamp">
                Data fetched {lastUpdated.toLocaleTimeString()} &middot;{" "}
                {lastUpdated.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
              </div>
            )}
            <ul className="footer-disclaimers">
              <li>Sector, overlap &amp; stock-exposure figures use full portfolio data (67 holdings, 100% AUM) sourced from Groww.</li>
              <li>Overlap is matched by internal instrument code, not fund name.</li>
              <li>Filters recompute instantly — press Refresh for fresh NAV data.</li>
            </ul>
          </div>
        </div>
      </footer>
    </>
  );
}

// ─── Table rows builder ───────────────────────────────────────────────────────

function buildTableRows(holdings: Holding[], fundMap: FundMap, totalCurrent: number) {
  return holdings.map(h => {
    const fd = fundMap[h.investment_code];
    return {
      name: h.investment,
      code: h.investment_code,
      cat: fd?.category || h.assetclass_l2 || "—",
      broker: h.broker || "—",
      r1y: fd?.returns1Y ?? null,
      r3y: fd?.returns3Y ?? null,
      invested: h.invested_amount || 0,
      current: h.market_value || 0,
      pnl: h.pnl_per || 0,
      weight: totalCurrent ? h.market_value / totalCurrent * 100 : 0,
    };
  });
}
