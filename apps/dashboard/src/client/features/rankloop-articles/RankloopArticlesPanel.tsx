import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  articleTab,
  type ArticleTab,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
import { RankloopArticlesTable } from "@/client/features/rankloop-articles/RankloopArticlesTable";
import { useArticlesPolling } from "@/client/features/rankloop-articles/useArticlesPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

// Tab → empty-state sentence. Writing hands you the action that fills it;
// Review says what has to happen first; Failed states the rule that puts a
// draft there, so an empty tab reads as good news rather than a gap.
const EMPTY_COPY: Record<ArticleTab, string> = {
  writing:
    "Nothing being written right now — approve a net-new proposal above and press Write.",
  review: "Nothing waiting on you — a draft lands here once every law passes.",
  failed:
    "Nothing failed. A draft that misses the laws three times lands here with its report intact.",
};

function ArticleTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab ${active ? "tab-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// Mirrors the loaded layout — tab strip over table rows inside the panel —
// so the shell stays put and only the data fills in.
function ArticlesLoadingState() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
    >
      <div className="flex items-center gap-4 border-b border-base-300 px-4 py-3">
        <div className="skeleton h-4 w-20" />
        <div className="skeleton h-4 w-16" />
        <div className="skeleton h-4 w-16" />
      </div>
      <div className="space-y-3 p-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skeleton h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * Drafts in flight, drafts waiting on a human, drafts the laws refused.
 *
 * One unfiltered fetch feeds all three tabs, so the counts and the lists can
 * never disagree — and the shared query is the same one the Write buttons
 * above read, which is why a row starts narrating "Drafting…" here at the
 * same moment the proposal row does.
 */
export function RankloopArticlesPanel({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<ArticleTab>("writing");
  const articlesQuery = useArticlesPolling(projectId);

  if (articlesQuery.isPending) return <ArticlesLoadingState />;

  if (articlesQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(articlesQuery.error)}
        </span>
      </div>
    );
  }

  const articles = articlesQuery.data;
  const writing = articles.filter(
    (row) => articleTab(row.status) === "writing",
  );
  const review = articles.filter((row) => articleTab(row.status) === "review");
  const failed = articles.filter((row) => articleTab(row.status) === "failed");
  const visible =
    tab === "writing" ? writing : tab === "review" ? review : failed;

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <div className="flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" className="tabs tabs-border w-fit">
          <ArticleTabButton
            active={tab === "writing"}
            onClick={() => setTab("writing")}
            label={`Writing (${writing.length})`}
          />
          <ArticleTabButton
            active={tab === "review"}
            onClick={() => setTab("review")}
            label={`Review (${review.length})`}
          />
          <ArticleTabButton
            active={tab === "failed"}
            onClick={() => setTab("failed")}
            label={`Failed (${failed.length})`}
          />
        </div>
        {/* The poll runs itself; this only says a request is in the air, so a
            3s refresh never looks like the screen jumping on its own. */}
        {articlesQuery.isFetching ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="p-6 text-sm text-base-content/60">{EMPTY_COPY[tab]}</p>
      ) : (
        <RankloopArticlesTable rows={visible} projectId={projectId} />
      )}

      <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
        one draft, then up to two repair passes · the laws that judge it make no
        model call · every generation is metered into the spend ledger
      </p>
    </div>
  );
}
