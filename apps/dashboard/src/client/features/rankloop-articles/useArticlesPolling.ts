import { useQuery } from "@tanstack/react-query";
import { isArticleRunning } from "@/client/features/rankloop-articles/articleDisplay.logic";
import { getRankloopArticles } from "@/serverFunctions/rankloopWriter";

/**
 * Polls the project's articles while any workflow is mid-run (3s, the house
 * cadence usePagePlanPolling set) so the tab counts, the rows under them and
 * the step gerund all narrate the same run from one shared query.
 *
 * The interval stops itself the moment nothing is in flight — a queue of
 * finished drafts costs no requests, which is what makes leaving this screen
 * open all afternoon reasonable.
 */
export function useArticlesPolling(projectId: string) {
  return useQuery({
    queryKey: ["rankloopArticles", projectId],
    queryFn: () => getRankloopArticles({ data: { projectId } }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((article) =>
        isArticleRunning(article.status),
      )
        ? 3000
        : false,
  });
}
