/**
 * How many generations one article is allowed, ever.
 *
 * Three INCLUDING the first draft, not three repairs after it. A model that
 * has read the same violated law twice and still breaks it is not one repair
 * away from complying, and the fourth call is how a writer quietly becomes a
 * money pit. After this the article goes to a human with its report intact,
 * which is the whole point of a gate that never negotiates.
 */
export const MAX_WRITE_ATTEMPTS = 3;

/**
 * What one generation is expected to cost, in USD.
 *
 * Deliberately a round two-decimal figure: it feeds the confirm modal's "~"
 * idiom, and quoting four decimals for a guess would imply a precision nobody
 * has before the tokens exist. The real number lands in `llm_spend` the moment
 * the call returns, and the receipt on the detail page shows that one.
 */
export const WRITE_ATTEMPT_COST_ESTIMATE_USD = 0.12;

export type TrustDial = "titles" | "drafts" | "autopilot";

/**
 * A passing draft's terminal status.
 *
 * `titles` means the human approved the title and asked not to read drafts,
 * so a draft that cleared every law goes straight to `approved`. Any other
 * dial keeps a person between the model and the site, which is the setting
 * this product ships defaulted to.
 *
 * It lives here, and not next to the workflow that lands drafts, because the
 * gate needs it too: a hand edit that clears the last law lands in the same
 * status a generated one would. Importing it from the writer service would
 * put the module that owns the model client on the grader's import graph,
 * and "the grader is never the author" is only worth something while that
 * stays provable by grep.
 */
export function landingStatus(trustDial: TrustDial): "approved" | "review" {
  return trustDial === "titles" ? "approved" : "review";
}
