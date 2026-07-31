import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  articleTab,
  type ArticlesPanelTab,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
import { RankloopArticlesTable } from "@/client/features/rankloop-articles/RankloopArticlesTable";
import { RankloopPublishedTable } from "@/client/features/rankloop-articles/RankloopPublishedTable";
import { useArticlesPolling } from "@/client/features/rankloop-articles/useArticlesPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getRankloopPublishedArticles } from "@/serverFunctions/rankloopPublishArticle";

// Tab → empty-state sentence. Writing hands you the action that fills it;
// Review says what has to happen first; Failed states the rule that puts a
// draft there, so an empty tab reads as good news rather than a gap.
const EMPTY_COPY: Record<ArticlesPanelTab, string> = {
  writing:
    "Nothing being written right now — approve a net-new proposal above and press Write.",
  review: "Nothing waiting on you — a draft lands here once every law passes.",
  failed:
    "Nothing failed. A draft that misses the laws three times lands here with its report intact.",
  published:
    "Nothing published yet — open a draft that passed and press Publish. Its hub is created first.",
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
        <div className="skeleton h-4 w-24" />
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
 * Drafts in flight, drafts waiting on a human, drafts the laws refused, and
 * the posts that made it onto the site.
 *
 * One unfiltered fetch feeds the first three tabs, so their counts and lists
 * can never disagree — and it is the same query the Write buttons above read,
 * which is why a row starts narrating "Drafting…" here at the same moment the
 * proposal row does. Published is its own read: a shipped post is described by
 * its URL, its hub, the links rankloop injected and its receipt, none of which
 * the queue's 3-second poll has any business carrying.
 */
export function RankloopArticlesPanel({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<ArticlesPanelTab>("writing");
  const articlesQuery = useArticlesPolling(projectId);
  const publishedQuery = useQuery({
    queryKey: ["rankloopPublishedArticles", projectId],
    queryFn: () => getRankloopPublishedArticles({ data: { projectId } }),
  });
  const published = publishedQuery.data ?? [];

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
  const queued =
    tab === "writing" ? writing : tab === "review" ? review : failed;
  const isEmpty =
    tab === "published" ? published.length === 0 : queued.length === 0;

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
          <ArticleTabButton
            active={tab === "published"}
            onClick={() => setTab("published")}
            label={`Published (${published.length})`}
          />
        </div>
        {/* The poll runs itself; this only says a request is in the air, so a
            3s refresh never looks like the screen jumping on its own. */}
        {articlesQuery.isFetching ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>

      {isEmpty ? (
        <p className="p-6 text-sm text-base-content/60">{EMPTY_COPY[tab]}</p>
      ) : tab === "published" ? (
        <RankloopPublishedTable rows={published} projectId={projectId} />
      ) : (
        <RankloopArticlesTable rows={queued} projectId={projectId} />
      )}

      <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
        one draft, then up to two repair passes · the laws that judge it make no
        model call · every generation is metered into the spend ledger
      </p>
    </div>
  );
}
