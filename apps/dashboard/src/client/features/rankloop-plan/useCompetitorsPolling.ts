import { useQuery } from "@tanstack/react-query";
import { getRankloopCompetitors } from "@/serverFunctions/rankloopCompetitors";

/**
 * Polls the project's competitors while any study run is active (3s, the
 * house polling cadence) so the tab strip's tracked count, the tracked table
 * and the progress spine all narrate the same runs from one shared query.
 */
export function useCompetitorsPolling(projectId: string) {
  return useQuery({
    queryKey: ["rankloopCompetitors", projectId],
    queryFn: () => getRankloopCompetitors({ data: { projectId } }),
    refetchInterval: (query) => {
      const tracked = query.state.data?.tracked ?? [];
      const studying = tracked.some(
        (row) => row.studyStatus === "pending" || row.studyStatus === "running",
      );
      return studying ? 3000 : false;
    },
  });
}
