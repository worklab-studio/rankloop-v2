import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { RankloopApplyRetitleModal } from "@/client/features/rankloop-articles/RankloopApplyRetitleModal";
import { RankloopBriefModal } from "@/client/features/rankloop-articles/RankloopBriefModal";
import { RankloopProposalsTable } from "@/client/features/rankloop-articles/RankloopProposalsTable";
import { RankloopQuotaBar } from "@/client/features/rankloop-articles/RankloopQuotaBar";
import { RankloopWriteConfirmModal } from "@/client/features/rankloop-articles/RankloopWriteConfirmModal";
import { useRankloopWriting } from "@/client/features/rankloop-articles/useRankloopWriting";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  attestPushProposal,
  attestRetitleProposal,
  getRankloopPublishConnection,
} from "@/serverFunctions/rankloopPublish";
import {
  decideRankloopProposal,
  getRankloopProposals,
  refreshRankloopProposals,
} from "@/serverFunctions/rankloopProposals";

type ProposalRow = Awaited<ReturnType<typeof getRankloopProposals>>[number];
type QueueTab = "proposed" | "approved" | "done" | "declined";
type Decision = "approved" | "declined";

// Tab → empty-state sentence. Proposed explains both mechanisms (optimize
// rows are computed from stored search memory, so none exist before a sync;
// net-new ones need an approved page type with keywords bound to it); done
// hands you the action that fills it; the decided tabs state the fact.
const EMPTY_COPY: Record<QueueTab, string> = {
  proposed:
    "No proposals yet — optimize rows appear after your search memory syncs, net-new ones once a page type is approved.",
  approved: "Nothing approved yet.",
  done: "Nothing done yet — approved proposals land here once applied.",
  declined: "Nothing declined yet.",
};

function QueueTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab ${active ? "tab-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// Mirrors the loaded layout — tab strip over table rows inside the panel —
// so the shell stays put and only the data fills in.
function ProposalsLoadingState() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
    >
      <div className="flex items-center gap-4 border-b border-base-300 px-4 py-3">
        <div className="skeleton h-4 w-24" />
        <div className="skeleton h-4 w-16" />
        <div className="skeleton h-4 w-16" />
      </div>
      <div className="space-y-3 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="skeleton h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function RankloopProposalsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<QueueTab>("proposed");
  const [applying, setApplying] = useState<ProposalRow | null>(null);
  const [briefing, setBriefing] = useState<ProposalRow | null>(null);

  // One unfiltered fetch feeds all four tabs, so the counts and the lists
  // can never disagree; rows arrive ordered score desc from the server.
  const proposalsQuery = useQuery({
    queryKey: ["rankloopProposals", projectId],
    queryFn: () => getRankloopProposals({ data: { projectId } }),
  });
  const proposals = proposalsQuery.data ?? [];

  // Shared with the Publishing section below the table — one query key, so
  // saving a connection there flips the banner and row actions here.
  const connectionQuery = useQuery({
    queryKey: ["rankloopPublishConnection", projectId],
    queryFn: () => getRankloopPublishConnection({ data: { projectId } }),
  });
  const hasConnection = Boolean(connectionQuery.data);

  // Generation lives here rather than in the table so the confirm modal is a
  // sibling of the queue, not a child of a row that may re-render out from
  // under it.
  const writing = useRankloopWriting(projectId);

  const proposed = proposals.filter((row) => row.status === "proposed");
  const approved = proposals.filter((row) => row.status === "approved");
  const done = proposals.filter((row) => row.status === "done");
  const declined = proposals.filter((row) => row.status === "declined");
  const visible =
    tab === "proposed"
      ? proposed
      : tab === "approved"
        ? approved
        : tab === "done"
          ? done
          : declined;

  const decideMutation = useMutation({
    mutationFn: (input: { proposalId: string; decision: Decision }) =>
      decideRankloopProposal({ data: { projectId, ...input } }),
    // Optimistic: flip the row's status in the cache immediately so it
    // moves between tabs without waiting on the round-trip; onError
    // restores the snapshot, onSettled re-syncs with the server either way.
    onMutate: async ({ proposalId, decision }) => {
      await queryClient.cancelQueries({
        queryKey: ["rankloopProposals", projectId],
      });
      const previous = queryClient.getQueryData<ProposalRow[]>([
        "rankloopProposals",
        projectId,
      ]);
      queryClient.setQueryData<ProposalRow[]>(
        ["rankloopProposals", projectId],
        (rows) =>
          rows?.map((row) =>
            row.id === proposalId ? { ...row, status: decision } : row,
          ),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["rankloopProposals", projectId],
          context.previous,
        );
      }
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't save the decision. Try again.",
        ),
      );
    },
    onSuccess: (_result, { decision }) => {
      toast.success(decision === "approved" ? "Approved" : "Declined");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
    },
  });

  // Attestation: the human says "I did it", the server flips the proposal to
  // done and opens the receipt. No optimistic flip — the receipt insert is
  // the part that matters, so the row moves only when the server confirms.
  const attestMutation = useMutation({
    mutationFn: (row: ProposalRow) =>
      row.type === "push"
        ? attestPushProposal({ data: { projectId, proposalId: row.id } })
        : attestRetitleProposal({ data: { projectId, proposalId: row.id } }),
    onSuccess: () => {
      toast.success("Marked done");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't mark it done. Try again."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopReceipts", projectId],
      });
    },
  });

  // The manual trigger from the spec — same idempotent computeProposals the
  // sync-chained step calls, so mashing this can't duplicate the queue.
  const refreshMutation = useMutation({
    mutationFn: () => refreshRankloopProposals({ data: { projectId } }),
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't refresh proposals."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
    },
  });

  if (proposalsQuery.isPending) return <ProposalsLoadingState />;

  if (proposalsQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(proposalsQuery.error)}
        </span>
      </div>
    );
  }

  const showConnectionBanner =
    connectionQuery.isSuccess &&
    connectionQuery.data === null &&
    approved.some((row) => row.type === "retitle");

  return (
    <>
      {showConnectionBanner ? (
        <div className="alert alert-info">
          <Info className="size-4 shrink-0" />
          <span className="text-sm">
            Connect WordPress to apply retitles from here — or apply them
            manually and mark done.
          </span>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        <div className="flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div role="tablist" className="tabs tabs-border w-fit">
            <QueueTabButton
              active={tab === "proposed"}
              onClick={() => setTab("proposed")}
              label={`Proposed (${proposed.length})`}
            />
            <QueueTabButton
              active={tab === "approved"}
              onClick={() => setTab("approved")}
              label="Approved"
            />
            <QueueTabButton
              active={tab === "done"}
              onClick={() => setTab("done")}
              label="Done"
            />
            <QueueTabButton
              active={tab === "declined"}
              onClick={() => setTab("declined")}
              label="Declined"
            />
          </div>
          <div className="flex items-center gap-2">
            {proposalsQuery.isFetching ? (
              <Loader2 className="size-4 animate-spin text-base-content/40" />
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Refresh
            </button>
          </div>
        </div>
        {/* Only on the queue you act from: what today owes is a fact about
            what to propose next, not about what you already decided. */}
        {tab === "proposed" ? <RankloopQuotaBar projectId={projectId} /> : null}
        {visible.length === 0 ? (
          <p className="p-6 text-sm text-base-content/60">{EMPTY_COPY[tab]}</p>
        ) : (
          <RankloopProposalsTable
            rows={visible}
            projectId={projectId}
            hasConnection={hasConnection}
            writing={{
              providerConfigured: writing.providerConfigured,
              articles: writing.articles,
              pendingProposalId: writing.pendingProposalId,
              onWrite: (row) =>
                writing.openConfirm({
                  id: row.id,
                  target: row.target,
                  title: row.title,
                }),
            }}
            decidingId={
              decideMutation.isPending
                ? (decideMutation.variables?.proposalId ?? null)
                : null
            }
            attestingId={
              attestMutation.isPending
                ? (attestMutation.variables?.id ?? null)
                : null
            }
            onDecide={(proposalId, decision) =>
              decideMutation.mutate({ proposalId, decision })
            }
            onApplyRetitle={(row) => setApplying(row)}
            onAttest={(row) => attestMutation.mutate(row)}
            onViewBrief={(row) => setBriefing(row)}
          />
        )}
        <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
          optimize rows computed after each search memory sync · net-new picks
          run daily under your quota · proposals expire after 10 days
        </p>
      </div>
      {applying ? (
        <RankloopApplyRetitleModal
          projectId={projectId}
          proposal={applying}
          onClose={() => setApplying(null)}
        />
      ) : null}
      {briefing ? (
        <RankloopBriefModal
          projectId={projectId}
          proposal={briefing}
          onClose={() => setBriefing(null)}
        />
      ) : null}
      {writing.confirming && writing.access ? (
        <RankloopWriteConfirmModal
          access={writing.access}
          target={writing.confirming.target}
          title={writing.confirming.title}
          isPending={writing.isStarting}
          onConfirm={writing.confirmWrite}
          onCancel={writing.cancelConfirm}
        />
      ) : null}
    </>
  );
}
