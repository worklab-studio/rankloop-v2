import { createFileRoute } from "@tanstack/react-router";
import { RankloopArticlesPanel } from "@/client/features/rankloop-articles/RankloopArticlesPanel";
import { RankloopProposalsPanel } from "@/client/features/rankloop-articles/RankloopProposalsPanel";
import { RankloopPublishingSettings } from "@/client/features/rankloop-articles/RankloopPublishingSettings";
import { RankloopWriterSettings } from "@/client/features/rankloop-articles/RankloopWriterSettings";

export const Route = createFileRoute("/_project/p/$projectId/articles/")({
  component: ArticlesIndex,
});

function ArticlesIndex() {
  const { projectId } = Route.useParams();
  return (
    <>
      <RankloopProposalsPanel projectId={projectId} />
      {/* Drafts sit under the queue in pipeline order: what was approved,
          then what is being written from it. */}
      <RankloopArticlesPanel projectId={projectId} />
      {/* Settings sit below the queue in pipeline order — what gets written,
          then where it lands. Both stay collapsed so the screen opens on the
          decisions, not on the configuration. */}
      <RankloopWriterSettings projectId={projectId} />
      <RankloopPublishingSettings projectId={projectId} />
    </>
  );
}
