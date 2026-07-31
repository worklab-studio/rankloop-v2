// Plan-time SERP economics, shared by the server (what a run actually spends)
// and the Page types tab (the cost sentence on the recompute button). Both
// numbers are provider prices, not billed amounts — the hosted markup lives in
// the metering seam, and a self-host operator pays exactly what is here.

/**
 * DataForSEO live SERP, one page of 10 results. The plan only ever reads the
 * top 10 — ugcTop5 lives in 1–5, weakness in 6–10 — so a plan sample is
 * always a single page.
 */
export const PLAN_SERP_CALL_COST_USD = 0.002;

/** Results crawled per plan sample: page one, and nothing past it. */
export const PLAN_SERP_DEPTH = 10;

/** Live SERP calls one plan run may spend. Forty is ~$0.08 — cheap enough to
 *  re-run without thinking about it, and enough to cover seven candidates at
 *  six samples each, which is more page types than any plan should propose. */
export const PLAN_SERP_CALL_BUDGET = 40;
