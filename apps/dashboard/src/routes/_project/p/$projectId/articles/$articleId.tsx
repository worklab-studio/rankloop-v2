import { createFileRoute } from "@tanstack/react-router";
import { RankloopArticleDetail } from "@/client/features/rankloop-articles/RankloopArticleDetail";

export const Route = createFileRoute(
  "/_project/p/$projectId/articles/$articleId",
)({
  component: ArticleDetailRoute,
});

function ArticleDetailRoute() {
  const { projectId, articleId } = Route.useParams();
  return <RankloopArticleDetail projectId={projectId} articleId={articleId} />;
}
