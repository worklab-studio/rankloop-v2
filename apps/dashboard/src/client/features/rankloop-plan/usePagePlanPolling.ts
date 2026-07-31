import { useQuery } from "@tanstack/react-query";
import { getRankloopPagePlan } from "@/serverFunctions/rankloopPagePlan";

/**
 * Polls the project's page plan while a planner run is active (3s, the house
 * cadence) so the tab strip's count, the approval cards under it and the
 * progress spine all narrate the same run from one shared query.
 */
export function usePagePlanPolling(projectId: string) {
  return useQuery({
    queryKey: ["rankloopPagePlan", projectId],
    queryFn: () => getRankloopPagePlan({ data: { projectId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.lastRun?.status;
      return status === "pending" || status === "running" ? 3000 : false;
    },
  });
}
