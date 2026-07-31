import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyCardBody } from "@/client/features/dashboard/cardParts";
import { linkGapStamp } from "@/client/features/rankloop-plan/outreachDisplay.logic";
import { RankloopOutreachMessageModal } from "@/client/features/rankloop-plan/RankloopOutreachMessageModal";
import { RankloopOutreachTable } from "@/client/features/rankloop-plan/RankloopOutreachTable";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import {
  getRankloopOutreach,
  recomputeRankloopOutreach,
  saveRankloopOutreachDraft,
  updateRankloopOutreachStatus,
} from "@/serverFunctions/rankloopOutreach";
import type { OutreachStatus } from "@/types/schemas/rankloopOutreach";

type RankloopOutreachData = Awaited<ReturnType<typeof getRankloopOutreach>>;
type OutreachTargetRow = RankloopOutreachData["targets"][number];

// The line that never moves, and it ships in the product rather than only in
// the spec: every other planner surface implies rankloop acts on its own, and
// this one must not be read that way for even one screen.
function OutreachHonestyAlert() {
  return (
    <div className="alert alert-info">
      <Info className="size-4 shrink-0" />
      <span className="text-sm">
        rankloop finds and drafts. You send. Nothing here contacts anyone.
      </span>
    </div>
  );
}

// Mirrors the loaded layout — one panel with a header row over table rows —
// so the shell stays put and only the data fills in.
function OutreachLoadingState() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
    >
      <div className="border-b border-base-300 px-4 py-3">
        <div className="skeleton h-4 w-24" />
      </div>
      <div className="space-y-3 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="skeleton h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function RankloopOutreachTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [drafting, setDrafting] = useState<OutreachTargetRow | null>(null);

  const outreachQuery = useQuery({
    queryKey: ["rankloopOutreach", projectId],
    queryFn: () => getRankloopOutreach({ data: { projectId } }),
  });

  const keyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
  });
  // An unverifiable key check lands in the pitch too, rather than
  // error-coloring a tab that may work fine on retry.
  const keyless =
    keyStatusQuery.isError ||
    (keyStatusQuery.isSuccess && !keyStatusQuery.data.configured);

  const invalidateOutreach = () =>
    queryClient.invalidateQueries({
      queryKey: ["rankloopOutreach", projectId],
    });

  // Optimistic, and deliberately silent: the board is a memory aid the human
  // just moved by hand, so the select has to stick the instant they let go of
  // it, and a toast per row would out-shout the work. onError restores the
  // snapshot, onSettled re-syncs with the server either way.
  const statusMutation = useMutation({
    mutationFn: (input: { targetId: string; status: OutreachStatus }) =>
      updateRankloopOutreachStatus({ data: { projectId, ...input } }),
    onMutate: async ({ targetId, status }) => {
      await queryClient.cancelQueries({
        queryKey: ["rankloopOutreach", projectId],
      });
      const previous = queryClient.getQueryData<RankloopOutreachData>([
        "rankloopOutreach",
        projectId,
      ]);
      queryClient.setQueryData<RankloopOutreachData>(
        ["rankloopOutreach", projectId],
        (data) =>
          data && {
            ...data,
            targets: data.targets.map((row) =>
              row.id === targetId ? { ...row, status } : row,
            ),
          },
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["rankloopOutreach", projectId],
          context.previous,
        );
      }
      toast.error(
        getStandardErrorMessage(error, "Couldn't save the status. Try again."),
      );
    },
    onSettled: () => {
      void invalidateOutreach();
    },
  });

  const draftMutation = useMutation({
    mutationFn: (input: { targetId: string; draftMessage: string }) =>
      saveRankloopOutreachDraft({ data: { projectId, ...input } }),
    onSuccess: () => {
      toast.success("Draft saved");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't save the draft. Try again."),
      );
    },
    onSettled: () => {
      void invalidateOutreach();
    },
  });

  // The manual half of the spec's refresh rule; the other half rides the end
  // of every competitor study. Both call the same upsert, which never resets
  // status, notes or an edited draft — so mashing this can't undo the board.
  const recomputeMutation = useMutation({
    mutationFn: () => recomputeRankloopOutreach({ data: { projectId } }),
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Couldn't refresh the gap."));
    },
    onSettled: () => {
      void invalidateOutreach();
    },
  });

  // Closing the modal is the save. An untouched draft writes nothing, so
  // opening a target to read its evidence never stamps updatedAt or toasts.
  const handleCloseDraft = (draftMessage: string) => {
    const target = drafting;
    setDrafting(null);
    if (!target || draftMessage === (target.draftMessage ?? "")) return;
    draftMutation.mutate({ targetId: target.id, draftMessage });
  };

  if (outreachQuery.isPending) {
    return (
      <div className="space-y-4">
        <OutreachHonestyAlert />
        <OutreachLoadingState />
      </div>
    );
  }

  if (outreachQuery.isError) {
    return (
      <div className="space-y-4">
        <OutreachHonestyAlert />
        <div className="alert alert-error">
          <span className="text-sm">
            {getStandardErrorMessage(outreachQuery.error)}
          </span>
        </div>
      </div>
    );
  }

  const { targets, trackedCompetitors, linkDomainsKnown } = outreachQuery.data;
  // Tracked competitors but not one stored referring domain means the study's
  // key-gated step skipped rather than failed. The key check decides which
  // way to read that: keyless it is the setup pitch, keyed it is simply a gap
  // that hasn't been collected yet.
  const needsKey = linkDomainsKnown === 0 && keyless;

  return (
    <div className="space-y-4">
      <OutreachHonestyAlert />

      <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        <div className="flex items-center justify-between gap-4 border-b border-base-300 px-4 py-3">
          <h2 className="text-base font-semibold leading-tight">Link gap</h2>
          <div className="flex items-center gap-2">
            {outreachQuery.isFetching ? (
              <Loader2 className="size-4 animate-spin text-base-content/40" />
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={recomputeMutation.isPending}
              onClick={() => recomputeMutation.mutate()}
            >
              {recomputeMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Refresh
            </button>
          </div>
        </div>

        {targets.length > 0 ? (
          <RankloopOutreachTable
            rows={targets}
            onStatusChange={(targetId, status) =>
              statusMutation.mutate({ targetId, status })
            }
            onDraft={(target) => setDrafting(target)}
          />
        ) : trackedCompetitors === 0 ? (
          <p className="p-6 text-sm text-base-content/60">
            Track a competitor first &mdash; the gap comes from who links to
            them.
          </p>
        ) : needsKey ? (
          <div className="p-5">
            <EmptyCardBody
              message="Add your DataForSEO API key to see who links to the competitors you track — their referring domains are the raw material of the gap."
              cta={
                <Link
                  {...dataforseoHelpLinkOptions}
                  className="link link-primary text-sm font-medium"
                >
                  Open setup guide →
                </Link>
              }
            />
          </div>
        ) : (
          <p className="p-6 text-sm text-base-content/60">
            No domain links to two or more of your competitors yet.
          </p>
        )}

        <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
          {linkGapStamp(trackedCompetitors)}
        </p>
      </div>

      {drafting ? (
        <RankloopOutreachMessageModal
          target={drafting}
          onClose={handleCloseDraft}
        />
      ) : null}
    </div>
  );
}
