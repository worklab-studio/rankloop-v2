import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatRelative } from "@/client/features/dashboard/cardParts";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopGscMemory,
  startRankloopGscSync,
} from "@/serverFunctions/rankloopGsc";

// Provenance row for rankloop's stored GSC memory. Deliberately quiet: the
// page's own numbers stay live-per-request; this only reports what the sync
// workflow has stored, and the button is the manual dispatch self-host relies
// on until DO-alarm scheduling lands (cron fires on Cloudflare deploys only).
export function SearchPerformanceMemoryStamp({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();

  const memoryQuery = useQuery({
    queryKey: ["rankloopGscMemory", projectId],
    queryFn: () => getRankloopGscMemory({ data: { projectId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.lastRun?.status;
      if (status === "pending" || status === "running") return 3000;
      return false;
    },
  });
  const memory = memoryQuery.data;

  const syncMutation = useMutation({
    mutationFn: () => startRankloopGscSync({ data: { projectId } }),
    // A duplicate start returns the existing active run rather than erroring,
    // so success always means a run is active — the refetch flips the button.
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopGscMemory", projectId],
      });
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Could not start sync"));
    },
  });

  if (!memory) return null;

  const status = memory.lastRun?.status;
  const isSyncing =
    status === "pending" || status === "running" || syncMutation.isPending;
  // An active first back-fill still reads "not synced yet" — dayCount stays 0
  // until rows land, and the button already says what is happening.
  const stamp =
    memory.dayCount > 0 && memory.lastRun
      ? `rankloop memory · ${memory.dayCount} day${
          memory.dayCount !== 1 ? "s" : ""
        } stored · synced ${formatRelative(
          memory.lastRun.finishedAt ?? memory.lastRun.startedAt,
        )}`
      : "rankloop memory · not synced yet";

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-base-content/45">{stamp}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={isSyncing}
        onClick={() => syncMutation.mutate()}
      >
        {isSyncing ? (
          <>
            <span className="loading loading-spinner loading-xs" />
            Syncing…
          </>
        ) : memory.dayCount > 0 ? (
          "Sync now"
        ) : (
          "Back-fill 90 days"
        )}
      </button>
    </div>
  );
}
