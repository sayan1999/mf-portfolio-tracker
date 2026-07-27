# Charts & Data Flow

## 1. What we fetch

Two sequential MCP calls. Step 2 needs fund IDs from Step 1.

**Step 1 — `networth_holdings` (`asset_type: "MF"`)**
Fields used: `investment`, `investment_code`, `invested_amount`, `market_value`, `pnl_per`, `broker`, `assetclass_l2`

**Step 2 — `get_mf_funds_details` (`fund_ids`, `includes: ["holdings","asset_allocation"]`)**
Fields used: `fund_detail.{name,category}`, `holdings[Equity].holds[].{name,image_url,sector,perc}`, `asset_allocation[Equity].market_cap_distribution.market_cap[].{name,value}`

> Instrument code is extracted from `image_url` as `…/instocks/1X/<CODE>.png`. Holdings without a URL get a fund-unique fallback key so they never false-match in overlap.

> `market_cap` values are % of the fund's equity corpus, not % of 100 — they are portfolio-weighted before display.

---

## 2. Charts

### Ticker bar
**Source:** Step 1 · `investment`, `pnl_per`
Scrolling marquee of fund short names + up/down % change. Duplicated for seamless CSS loop.

### Overview cards (Invested / Current / Gain / Return)
**Source:** Step 1 · `invested_amount`, `market_value`
Summed across filtered holdings. Gain = current − invested. Return % = gain / invested × 100.

### Allocation by asset class (donut)
**Source:** Step 1 · `assetclass_l2`, `market_value`
Groups holdings by `assetclass_l2`, values as % of total current value.

### Equity by market cap (donut)
**Source:** Step 2 · `market_cap_distribution.market_cap[].{name,value}`
Each fund's market cap split is weighted by that fund's share of total portfolio value, then summed across all funds.

### Sector exposure (stacked bar)
**Source:** Step 2 · `holdings[Equity].holds[].{sector,perc}`
Each stock's sector % is multiplied by the fund's portfolio weight (fund market value / total). Stacked by fund, X-axis = sectors sorted by total exposure.

### Stock exposure — consolidated (horizontal bar)
**Source:** Step 2 · `holdings[Equity].holds[].{name, pct}`
For each unique stock, computes `sum over all funds (fund portfolio weight × stock % in fund)` = that stock's total % of the whole portfolio. Top 18 stocks shown, sorted descending. Answers "how much HDFC Bank does my entire portfolio hold?" regardless of how many funds hold it.

### Top holdings per fund (stacked bar)
**Source:** Step 2 · `holdings[Equity].holds[].{name,image_url,perc}`
Stocks ≥ 5% of the fund get individual color segments. Remainder merged into "Others". Bar height = fund's % of total AUM. Tooltip shows both % of fund and % of AUM.

### Fund overlap
**Source:** Step 2 · `holds[]` (same data as sector/top-holdings)
Stocks held by 2+ funds are identified by instrument code (not name). Shows cross-held % of portfolio value and pairwise fund similarity (min-weight overlap method).

### Funds table
**Source:** Step 1 (all columns) + Step 2 (`category`, `returns1Y`, `returns3Y`)
Sortable by any column. Category and returns columns show "—" until Step 2 completes.
