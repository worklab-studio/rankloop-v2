import { Loader2 } from "lucide-react";
import { articleStepLabel } from "@/client/features/rankloop-articles/articleDisplay.logic";

type LawEntry = { law: string; passed: boolean };

// Terminal labels, sentence case. "Ready for review" and "Approved" are the
// two ways a draft can pass — the trust dial picks which, and the badge says
// so rather than collapsing both into "done".
const TERMINAL_LABELS: Record<string, string> = {
  review: "Ready for review",
  approved: "Approved",
  failed: "Failed",
  published: "Published",
};

/**
 * What the workflow is doing to this article, or what it left behind.
 *
 * A running row wears the step as a gerund, so the badge is a narration of
 * the pgStep executing rather than a spinner that could mean anything.
 */
export function ArticleStatusBadge({
  status,
  lawReport,
}: {
  status: string;
  lawReport: LawEntry[] | null;
}) {
  const step = articleStepLabel(status, lawReport);
  if (step) {
    return (
      <span className="badge badge-info badge-sm gap-1">
        <Loader2 className="size-3 animate-spin" />
        {step}
      </span>
    );
  }

  if (status === "failed") {
    return <span className="badge badge-error badge-sm">Failed</span>;
  }

  const label = TERMINAL_LABELS[status] ?? status;
  if (status === "review" || status === "approved") {
    return (
      <span className="badge badge-outline badge-sm border-success/30 bg-success/5 text-success/80">
        {label}
      </span>
    );
  }
  return <span className="badge badge-ghost badge-sm">{label}</span>;
}
