import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RankloopCompetitorDetail } from "@/client/features/rankloop-plan/RankloopCompetitorDetail";
import { getRankloopCompetitor } from "@/serverFunctions/rankloopCompetitors";

export const Route = createFileRoute(
  "/_project/p/$projectId/plan/competitors/$competitorId",
)({
  component: CompetitorDetailRoute,
});

function CompetitorDetailRoute() {
  const { projectId, competitorId } = Route.useParams();

  // Its own endpoint rather than a find() over the list query: the detail
  // carries the studied playbook and both page tables, which the tracked
  // table has no use for. Polls at the house 3s cadence while this
  // competitor's study runs so the cards fill in as the steps land.
  const { data: detail, isPending } = useQuery({
    queryKey: ["rankloopCompetitor", projectId, competitorId],
    queryFn: () => getRankloopCompetitor({ data: { projectId, competitorId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.competitor.studyStatus;
      if (status === "pending" || status === "running") return 3000;
      return false;
    },
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-base-content/70">
          This competitor is no longer tracked.
        </p>
        <Link
          to="/p/$projectId/plan"
          params={{ projectId }}
          className="btn btn-ghost btn-sm"
        >
          Back to competitors
        </Link>
      </div>
    );
  }

  return <RankloopCompetitorDetail projectId={projectId} detail={detail} />;
}
