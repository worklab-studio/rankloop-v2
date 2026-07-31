import { createFileRoute } from "@tanstack/react-router";
import { RankloopPlanTabs } from "@/client/features/rankloop-plan/RankloopPlanTabs";

export const Route = createFileRoute("/_project/p/$projectId/plan/")({
  component: PlanIndex,
});

function PlanIndex() {
  const { projectId } = Route.useParams();
  return <RankloopPlanTabs projectId={projectId} />;
}
