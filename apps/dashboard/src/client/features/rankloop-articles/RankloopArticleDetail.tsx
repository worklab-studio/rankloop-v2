import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
  FAILED_STATE_COPY,
  isArticleRunning,
  isPublishStage,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
import { RankloopArticleEditor } from "@/client/features/rankloop-articles/RankloopArticleEditor";
import { RankloopArticleReport } from "@/client/features/rankloop-articles/RankloopArticleReport";
import { ArticleStatusBadge } from "@/client/features/rankloop-articles/RankloopArticleStatus";
import { RankloopPublishPanel } from "@/client/features/rankloop-articles/RankloopPublishPanel";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopArticle,
  recheckRankloopArticle,
} from "@/serverFunctions/rankloopWriter";

// Mirrors the loaded layout — two columns, the draft panel beside the report
// — so the shell stays put and only the content fills in.
function ArticleDetailLoadingState() {
  return (
    <div aria-busy className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 rounded-xl border border-base-300 bg-base-100 p-4 lg:col-span-2">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-4/5" />
      </div>
      <div className="space-y-2 rounded-xl border border-base-300 bg-base-100 p-4">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="skeleton h-3 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * One article, and the two things that explain it: the draft on the left, the
 * report on the right.
 *
 * The columns are the product's argument in a layout — a draft is never shown
 * without the grade it earned, and the grade is never shown without the text
 * it was given.
 */
export function RankloopArticleDetail({
  projectId,
  articleId,
}: {
  projectId: string;
  articleId: string;
}) {
  const queryClient = useQueryClient();

  // Same 3s cadence as the queue: a detail screen opened mid-run narrates the
  // steps, then stops polling the moment the workflow lets go of the row.
  const articleQuery = useQuery({
    queryKey: ["rankloopArticle", projectId, articleId],
    queryFn: () => getRankloopArticle({ data: { projectId, articleId } }),
    refetchInterval: (query) =>
      query.state.data && isArticleRunning(query.state.data.status)
        ? 3000
        : false,
  });

  const recheckMutation = useMutation({
    mutationFn: (content: string) =>
      recheckRankloopArticle({ data: { projectId, articleId, content } }),
    onSuccess: (result) => {
      if (result.failedCount === 0) {
        toast.success("Saved — all laws pass");
        return;
      }
      toast.success(
        `Saved — ${result.failedCount} law${
          result.failedCount === 1 ? "" : "s"
        } still failing`,
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't re-check the draft. Try again.",
        ),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopArticle", projectId, articleId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopArticles", projectId],
      });
    },
  });

  if (articleQuery.isPending) return <ArticleDetailLoadingState />;

  const article = articleQuery.data ?? null;
  if (!article) {
    return (
      <>
        <p className="text-sm text-base-content/70">
          We could not load this article. It may have been deleted.
        </p>
        <Link
          to="/p/$projectId/articles"
          params={{ projectId }}
          className="btn btn-ghost btn-sm"
        >
          Back to articles
        </Link>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        to="/p/$projectId/articles"
        params={{ projectId }}
        className="btn btn-ghost btn-sm gap-2 px-0 text-base-content/70 hover:bg-transparent"
      >
        <ArrowLeft className="size-4" />
        Articles
      </Link>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            className="truncate text-lg font-semibold"
            title={article.title ?? article.keyword}
          >
            {article.title ?? article.keyword}
          </h2>
          <p className="truncate font-mono text-xs text-base-content/50">
            {article.keyword}
          </p>
        </div>
        <ArticleStatusBadge
          status={article.status}
          lawReport={article.lawReport}
        />
      </div>

      {article.status === "failed" ? (
        <div className="alert alert-warning">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="text-sm">{FAILED_STATE_COPY}</span>
        </div>
      ) : null}

      {/* Above the draft, not beside it: publishing is the decision this
          screen exists to make once the laws have passed, and burying it in
          the right column would put the site-write below the fold. */}
      {isPublishStage(article.status) ? (
        <RankloopPublishPanel
          projectId={projectId}
          articleId={article.id}
          status={article.status}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <RankloopArticleEditor
            articleId={article.id}
            content={article.content}
            isSaving={recheckMutation.isPending}
            onSave={(markdown) => recheckMutation.mutate(markdown)}
          />
        </div>
        <div className="min-w-0">
          <RankloopArticleReport article={article} />
        </div>
      </div>
    </div>
  );
}
