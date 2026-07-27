"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

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

interface StockHolding { name: string; code: string | null; sector: string; pct: number }

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
  const [statusText, setStatusText] = useState("Initializing…");
  const [statusLive, setStatusLive] = useState(false);
  // Filters
  const [filters, setFilters] = useState<Filters>({ broker: "groww", excludeLiquidArb: true, excludeRegular: true });
  // Table sort
  const [sortKey, setSortKey] = useState("current");
  const [sortDir, setSortDir] = useState(-1);
  // Overlay UI
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [warnMsg, setWarnMsg] = useState<string | null>(null);
  const [footNote, setFootNote] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Derived for table/overlap (state so we can re-render on sort)
  const [tableRows, setTableRows] = useState<ReturnType<typeof buildTableRows>>([]);
  const [overlapHtml, setOverlapHtml] = useState("");
  const [tickerHtml, setTickerHtml] = useState("");
  const [overviewHtml, setOverviewHtml] = useState("");
  const [capCaptionHtml, setCapCaptionHtml] = useState("");
  const [assetCaptionHtml, setAssetCaptionHtml] = useState("");

  // Canvas refs
  const assetCanvasRef = useRef<HTMLCanvasElement>(null);
  const capCanvasRef = useRef<HTMLCanvasElement>(null);
  const sectorCanvasRef = useRef<HTMLCanvasElement>(null);
  const topHoldCanvasRef = useRef<HTMLCanvasElement>(null);
  const charts = useRef<Record<string, Chart>>({});

  function destroyChart(id: string) {
    charts.current[id]?.destroy();
    delete charts.current[id];
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setAuthState("checking");
    setAuthError(null);
    try {
      const res = await fetch("/api/mcp/connect", { method: "POST" });
      const data = await res.json();
      if (data.status === "CONNECTED") {
        setAuthState("connected");
      } else if (data.status === "AUTH_REQUIRED") {
        setAuthState("auth_pending");
        window.open(data.authUrl, "_blank");
      } else {
        setAuthError(data.message ?? "Connection failed");
        setAuthState("error");
      }
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
      setAuthState("error");
    }
  }, []);

  // Listen for auth-done signal from popup tab
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== "mcp_auth_done") return;
      localStorage.removeItem("mcp_auth_done");
      if (e.newValue === "ok") connect();
      else { setAuthError(`Auth failed: ${e.newValue}`); setAuthState("error"); }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [connect]);

  // Auto-check auth on mount
  useEffect(() => { connect(); }, [connect]);

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

      setFundMap(fdData.fundMap);
      setFundMapLoaded(true);
      setStep2("done");
      setStep2Detail(`${ids.length}/${ids.length}`);

      const now = new Date();
      setLastUpdated(now);
      setStatusLive(true);
      setStatusText(`Live · updated ${now.toLocaleTimeString()}`);
      setFootNote(
        `Data from INDmoney at ${now.toLocaleTimeString()} on ${now.toLocaleDateString()}. ` +
        `Sector/overlap/top-holdings figures derive from each fund's disclosed top equity holdings, not full portfolio. ` +
        `Overlap matched by internal instrument code, not name. Filters recompute instantly — press Refresh for fresh NAV.`
      );
    } catch (e) {
      setStep1(s => s === "loading" ? "error" : s);
      setStep2(s => s === "loading" ? "error" : s);
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
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${Number(c.raw).toFixed(2)}%` } }
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
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${Number(c.raw).toFixed(2)}%` } }
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
      fd.stocks.forEach(s => {
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
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.raw}%` } },
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
                return pof != null
                  ? ` ${c.dataset.label}: ${pof.toFixed(1)}% of fund (${c.raw}% of AUM)`
                  : ` ${c.dataset.label}: ${c.raw}% of AUM`;
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

  // Cleanup charts on unmount
  useEffect(() => () => { Object.values(charts.current).forEach(c => c.destroy()); }, []);

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

  // Overlap
  useEffect(() => {
    if (!fundMapLoaded || filtered.length < 2) { setOverlapHtml(""); return; }
    const stockAlloc: Record<string, { display: string; byFund: Record<string, number> }> = {};
    const fundStockFrac: Record<string, Record<string, number>> = {};
    const fundCodes: string[] = [];

    filtered.forEach(h => {
      const fd = fundMap[h.investment_code];
      if (!fd?.stocks?.length) return;
      const fc = h.investment_code;
      fundCodes.push(fc);
      fundStockFrac[fc] = fundStockFrac[fc] || {};
      fd.stocks.forEach(s => {
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
      setOverlapHtml('<div class="empty">Not enough disclosed data to compute overlap for the current filters</div>');
      return;
    }

    const topCross = crossHeld
      .map(([, v]) => ({ stock: v.display, value: Object.values(v.byFund).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.value - a.value).slice(0, 8);
    const maxVal = topCross[0]?.value || 1;

    const pairs: { fa: string; fb: string; ov: number }[] = [];
    for (let i = 0; i < uniqueCodes.length; i++) {
      for (let j = i + 1; j < uniqueCodes.length; j++) {
        const ca = uniqueCodes[i], cb = uniqueCodes[j];
        const wa = fundStockFrac[ca] || {}, wb = fundStockFrac[cb] || {};
        const common = Object.keys(wa).filter(s => wb[s] !== undefined);
        if (!common.length) continue;
        const ov = common.reduce((s, st) => s + Math.min(wa[st], wb[st]), 0) * 100;
        if (ov > 0.5) pairs.push({ fa: shortLabels[ca], fb: shortLabels[cb], ov });
      }
    }
    pairs.sort((a, b) => b.ov - a.ov);

    let html = `<div style="margin-bottom:16px">
      <div class="metric" style="display:inline-block;min-width:220px">
        <div class="label">Cross-held exposure</div>
        <div class="value">${crossPct.toFixed(1)}%</div>
        <div class="delta">${inr(crossVal)} across stocks held by 2+ funds</div>
      </div></div>`;

    html += topCross.map(o => {
      const pct = totalCurrent ? (o.value / totalCurrent * 100) : 0;
      return `<div class="overlap-row">
        <div class="overlap-label">${o.stock}</div>
        <div class="overlap-bar-bg"><div class="overlap-bar-fg" style="width:${(o.value / maxVal * 100).toFixed(1)}%"></div></div>
        <div class="overlap-pct">${inr(o.value)} (${pct.toFixed(1)}%)</div>
      </div>`;
    }).join("");

    html += `<div style="margin-top:20px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Pairwise similarity — disclosed top holdings</div>`;
    html += pairs.slice(0, 10).map(p => `
      <div class="overlap-row">
        <div class="overlap-label">${p.fa} × ${p.fb}</div>
        <div class="overlap-bar-bg"><div class="overlap-bar-fg" style="width:${Math.min(p.ov, 100).toFixed(1)}%"></div></div>
        <div class="overlap-pct">${p.ov.toFixed(1)}%</div>
      </div>`).join("");

    setOverlapHtml(html);
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
          {authState === "auth_pending" ? (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>Login tab opened — complete authentication there.</p>
          ) : (
            <button
              className="btn-connect"
              disabled={authState === "checking"}
              onClick={connect}
            >
              {authState === "checking" ? "Connecting…" : "Connect to INDmoney"}
            </button>
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
            <div className="h-title">Portfolio Terminal</div>
            <div className="h-sub">Mutual fund holdings · live via INDmoney{lastUpdated ? ` · ${lastUpdated.toLocaleDateString()}` : ""}</div>
          </div>
          <div className="h-actions">
            <span>
              <span className={`status-dot${statusLive ? " live" : errMsg ? " err" : ""}`} />
              <span id="statusText" style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)" }}>{statusText}</span>
            </span>
            <button className="refresh" onClick={() => loadData(true)} disabled={step1 === "loading" || step2 === "loading"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={step1 === "loading" || step2 === "loading" ? "spin" : ""}>
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
          <span className="step-hint">step 2 needs fund IDs from step 1</span>
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
                {sortedRows.map(r => (
                  <tr key={r.code}>
                    <td className="fund-name" title={r.name}>{r.name}</td>
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
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Sector chart */}
        <div className="card">
          <h2>Sector exposure — portfolio-weighted</h2>
          <div className="chart-box-tall">
            {!fundMapLoaded && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 6 }} />}
            <canvas ref={sectorCanvasRef} />
          </div>
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
              Bar height = fund&apos;s <b>% of total AUM</b>. A stock gets its own color only if ≥<b>{BIG_HOLDING_THRESHOLD}%</b> of that fund. Hover a segment for fund % and AUM %. Smaller positions merged into &quot;Others&quot;.
            </div>
          )}
        </div>

        {/* Overlap */}
        <div className="card">
          <h2>Fund overlap</h2>
          {overlapHtml ? (
            <div dangerouslySetInnerHTML={{ __html: overlapHtml }} />
          ) : (
            <><div className="skeleton sk-line" /><div className="skeleton sk-line" /></>
          )}
        </div>

        {footNote && <div className="foot-note">{footNote}</div>}
      </div>
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
