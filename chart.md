# Chart → Data Dependency Map

All data flows from two sequential MCP tool calls. Step 2 cannot start until Step 1 completes (needs fund IDs).

---

## Step 1 — `networth_holdings` (asset_type: "MF")

Fields used: `investment`, `investment_code`, `invested_amount`, `market_value`, `pnl_per`, `broker`, `assetclass_l2`

| Chart / Section | Fields consumed | Extra fetch needed? |
|---|---|---|
| Ticker bar | `investment`, `pnl_per` | No |
| Overview (Invested / Current / Gain / Return %) | `invested_amount`, `market_value` | No |
| Allocation by asset class (donut) | `assetclass_l2`, `market_value` | No |
| Funds table — all columns except Category | `investment`, `invested_amount`, `market_value`, `pnl_per`, `broker` | No |
| Funds table — Category column | needs Step 2 | Yes |
| Filter bar (broker / liquid+arb / regular plan) | `broker`, `assetclass_l2`, `investment` | No |

---

## Step 2 — `get_mf_funds_details` (fund_ids: all codes from Step 1, includes: ["holdings","asset_allocation"])

Fields used: `data[].data.fund_detail.category`, `data[].data.holdings.holdings[Equity].holds[]`, `data[].data.asset_allocation[Equity].market_cap_distribution.market_cap[]`

| Chart / Section | Fields consumed |
|---|---|
| Equity by market cap (donut) | `market_cap_distribution.market_cap[].{name, value}` — each value = % of that fund's corpus |
| Sector exposure — stacked bar (portfolio-weighted) | `holdings[Equity].holds[].{sector, perc}` × portfolio weight of each fund |
| Top holdings per fund — stacked bar | `holdings[Equity].holds[].{name, image_url, perc}` — instrument code extracted from `image_url` |
| Fund overlap — cross-held stocks + pairwise similarity | Same `holds[]` data; match key = internal instrument code from `image_url` (not name text) |
| Funds table — Category column | `fund_detail.category` |

---

## Data shape notes (issues found in sample.html)

- `market_cap` values are **% of the fund's total corpus**, not % of 100. Large+Mid+Small does NOT sum to 100 — they sum to the fund's equity allocation %. The sample normalises them against their own sub-sum before displaying, which is correct.
- Instrument code is embedded in `image_url` as `…/instocks/1X/<CODE>.png`. Holdings without a code (debt instruments, some foreign stocks) are given a fund-unique fallback key so they can't false-match across funds — overlap is slightly understated, never overstated.
- Two funds can have the same 4-word short name (e.g. Direct vs Regular variant from the same AMC). `buildShortLabels` extends word count until unique — must be preserved.
