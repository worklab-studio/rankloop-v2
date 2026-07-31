import { useQuery } from "@tanstack/react-query";
import { getRankloopUniverseRun } from "@/serverFunctions/rankloopUniverse";

/**
 * Polls the project's keyword-universe run while one is active (3s, the house
 * cadence) so the source buttons, the tab strip's count and the run stamp all
 * narrate the same run from one shared query.
 */
export function useKeywordUniversePolling(projectId: string) {
  return useQuery({
    queryKey: ["rankloopUniverseRun", projectId],
    queryFn: () => getRankloopUniverseRun({ data: { projectId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.latestRun?.status;
      return status === "pending" || status === "running" ? 3000 : false;
    },
  });
}
