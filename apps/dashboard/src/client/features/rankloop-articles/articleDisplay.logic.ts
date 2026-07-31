import { formatCost } from "@/client/features/rankloop-articles/netNewDisplay.logic";

// Structural subsets of what an article row carries, so this module stays a
// pure display layer with no server or db import behind it — the same shape
// netNewDisplay.logic.ts and proposalDisplay.logic.ts take.
type LawEntry = { law: string; passed: boolean };

type Stamp = {
  attempts: number;
  /** Null in agent mode — spend is only known when this app made the calls. */
  costUsd: number | null;
  model: string | null;
};

export type ArticleTab = "writing" | "review" | "failed";

/**
 * The tabs the queue panel renders.
 *
 * Published is deliberately not an `ArticleTab`: the four things worth showing
 * about a shipped post — the live URL, the hub, the links rankloop injected
 * and the receipt's status — live on rows the queue's poll does not carry, so
 * that tab reads from its own query and this union is where the two meet.
 */
export type ArticlesPanelTab = ArticleTab | "published";

/**
 * Which of the three queue tabs an article status belongs on.
 *
 * `approved` sits beside `review` rather than in a tab of its own: the trust
 * dial decides which of the two a passing draft lands in, and a user who set
 * the dial to "titles" should still find the draft where drafts live.
 * `published` returns null — a shipped post has left the queue.
 */
export function articleTab(status: string): ArticleTab | null {
  if (
    status === "briefing" ||
    status === "writing" ||
    status === "gate" ||
    status === "fixing"
  ) {
    return "writing";
  }
  if (status === "review" || status === "approved") return "review";
  if (status === "failed") return "failed";
  return null;
}

/** Is a workflow still moving this article? The polling cadence keys off it. */
export function isArticleRunning(status: string): boolean {
  return articleTab(status) === "writing" || status === "publishing";
}

/**
 * Does the detail screen offer the Publish panel?
 *
 * Only once a draft has cleared the laws. A draft still being written has
 * nothing to publish, and a failed one has a report to read instead — showing
 * a Publish button beside either would offer a decision the preflight is going
 * to refuse anyway.
 */
export function isPublishStage(status: string): boolean {
  return (
    status === "review" ||
    status === "approved" ||
    status === "publishing" ||
    status === "published"
  );
}

/**
 * The current step, as a gerund.
 *
 * The workflow's own step names are the vocabulary — a row narrating
 * "Checking laws…" is telling the truth about which pgStep is executing, not
 * animating a generic spinner. The fixing label carries the count because the
 * number of violations is the one thing that says whether the repair pass is
 * close.
 */
export function articleStepLabel(
  status: string,
  lawReport: LawEntry[] | null,
): string | null {
  if (status === "briefing") return "Assembling the brief…";
  if (status === "writing") return "Drafting…";
  if (status === "gate") return "Checking laws…";
  if (status === "publishing") return "Publishing…";
  if (status !== "fixing") return null;
  // A fixing row with no report yet is the gap between the gate storing its
  // verdict and the repair call starting; say less rather than say "0".
  const failed = failedLaws(lawReport).length;
  if (failed === 0) return "Fixing violations…";
  return `Fixing ${failed} violation${failed === 1 ? "" : "s"}…`;
}

export function failedLaws<T extends LawEntry>(report: T[] | null): T[] {
  return (report ?? []).filter((entry) => !entry.passed);
}

/**
 * The receipt line under the law report: what this draft cost and how many
 * tries it took. Both fragments drop out when they are unknown rather than
 * rendering a zero — an agent-mode article genuinely has no dollar figure,
 * and inventing "$0.00" would claim the writing was free.
 */
export function articleStampLine({ attempts, costUsd, model }: Stamp): string {
  const parts = [`${attempts} attempt${attempts === 1 ? "" : "s"}`];
  if (costUsd !== null) parts.push(formatCost(costUsd));
  if (model !== null) parts.push(`${model} via OpenRouter`);
  return parts.join(" · ");
}

/**
 * The spend math, stated before the money moves. The per-attempt figure is
 * what one generation costs; the ceiling is what a draft that keeps missing
 * the laws costs, because the fix loop is bounded and the user is entitled to
 * the worst case rather than the happy one.
 */
export function writeCostLine(
  estimatedAttemptCostUsd: number,
  maxAttempts: number,
): string {
  const ceiling = formatCost(estimatedAttemptCostUsd * maxAttempts);
  return `${formatCost(estimatedAttemptCostUsd)} per attempt × up to ${maxAttempts} attempts = ${ceiling} at most`;
}

/** Verbatim from spec 0020 — the whole failed state is these two sentences. */
export const FAILED_STATE_COPY =
  "Three attempts did not clear the laws. The draft and the report are below — edit it yourself, or decline the proposal.";
