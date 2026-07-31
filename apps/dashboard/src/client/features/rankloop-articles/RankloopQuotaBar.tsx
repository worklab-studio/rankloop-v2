import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  exclusionLine,
  quotaLine,
} from "@/client/features/rankloop-articles/netNewDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopWritingQuota,
  proposeRankloopNetNew,
} from "@/serverFunctions/rankloopWriting";

/**
 * The quota line above the queue, plus the manual trigger. The daily block
 * runs the same selection, so this button is a "don't wait until tomorrow"
 * affordance rather than the only way in — and because the line reconciles
 * owed against already-proposed, pressing it twice is visibly a no-op.
 */
export function RankloopQuotaBar({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const quotaQuery = useQuery({
    queryKey: ["rankloopWritingQuota", projectId],
    queryFn: () => getRankloopWritingQuota({ data: { projectId } }),
  });
  const quota = quotaQuery.data ?? null;

  const proposeMutation = useMutation({
    mutationFn: () => proposeRankloopNetNew({ data: { projectId } }),
    onSuccess: (result) => {
      // A no-op run is a fact about the quota, not a failure — the server
      // records why (quota met, quota off, nothing bound to an approved type)
      // and it surfaces verbatim instead of a generic "nothing happened".
      if (result.created === 0) {
        toast.info(result.reason ?? "Nothing to propose right now");
        return;
      }
      toast.success(
        `Proposed ${result.created} article${result.created === 1 ? "" : "s"}`,
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't propose articles. Try again."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopWritingQuota", projectId],
      });
    },
  });

  // When indexation has throttled the run, the throttle takes the headline and
  // the quota arithmetic drops to the line below it. Showing "2 owed today"
  // over a run that will write one is the number without the reason — which is
  // the shape of a bug, not of a decision.
  const throttleReason = quota?.throttle?.reason ?? null;
  const arithmetic = quota
    ? quotaLine(quota)
    : "couldn't read today's quota — propose manually";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-base-300 px-4 py-2.5">
      <div className="min-w-0">
        {quotaQuery.isPending ? (
          <div aria-busy className="skeleton h-4 w-44" />
        ) : (
          <p className="text-sm text-base-content/70">
            {throttleReason ?? arithmetic}
          </p>
        )}
        {throttleReason ? (
          <p className="mt-1 text-xs text-base-content/55">{arithmetic}</p>
        ) : null}
        {/* The no-data-no-page law, arriving here rather than as a surprise
            later: a pSEO type with no dataset behind it is never proposed, and
            the queue says so with the planner's own reason. */}
        {quota?.exclusions.map((exclusion) => (
          <p
            key={exclusion.pageTypeId}
            className="mt-1 text-xs text-base-content/55"
          >
            {exclusionLine(exclusion)}
          </p>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        disabled={proposeMutation.isPending}
        onClick={() => proposeMutation.mutate()}
      >
        {proposeMutation.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : null}
        Propose now
      </button>
    </div>
  );
}
