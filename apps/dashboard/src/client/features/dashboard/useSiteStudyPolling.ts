import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRankloopSiteStudy } from "@/serverFunctions/rankloopSiteStudy";

/**
 * Polls the project's site study while a run is active (3s, the house
 * polling cadence) so the progress spine and the Content inventory card
 * narrate the same run from one shared query.
 */
export function useSiteStudyPolling(projectId: string) {
  const queryClient = useQueryClient();
  const prevStatusRef = useRef<string | undefined>(undefined);

  const { data: study } = useQuery({
    queryKey: ["rankloopSiteStudy", projectId],
    queryFn: () => getRankloopSiteStudy({ data: { projectId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.lastRun?.status;
      const prev = prevStatusRef.current;
      prevStatusRef.current = status;

      // A finishing study may have started a fresh audit under the hood,
      // so the Site audit card's numbers go stale the moment the run ends.
      const isTerminal = status === "done" || status === "error";
      const wasActive = prev === "pending" || prev === "running";
      if (wasActive && isTerminal) {
        void queryClient.invalidateQueries({
          queryKey: ["dashboardOverview", projectId],
        });
      }

      if (status === "pending" || status === "running") return 3000;
      return false;
    },
  });

  return study;
}
