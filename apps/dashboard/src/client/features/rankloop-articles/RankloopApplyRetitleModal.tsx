import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { retitleWinningQueries } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  executeRetitleProposal,
  getRankloopRetitleContext,
} from "@/serverFunctions/rankloopPublish";
import type { getRankloopProposals } from "@/serverFunctions/rankloopProposals";
import { tagChipClass } from "@/shared/tag-colors";

type ProposalRow = Awaited<ReturnType<typeof getRankloopProposals>>[number];

/** Title/meta length guidance, not hard limits: Google truncates around
 *  these widths but truncation is pixel-based, so the counter warns instead
 *  of clamping. */
const TITLE_LENGTH_HINT = 70;
const META_LENGTH_HINT = 165;

function CharCount({ length, hint }: { length: number; hint: number }) {
  return (
    <span
      className={`text-xs tabular-nums ${
        length > hint ? "text-warning" : "text-base-content/50"
      }`}
    >
      {length}/{hint}
    </span>
  );
}

export function RankloopApplyRetitleModal({
  projectId,
  proposal,
  onClose,
}: {
  projectId: string;
  proposal: ProposalRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [newTitle, setNewTitle] = useState("");
  const [newMetaDescription, setNewMetaDescription] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  // Fetched on open so the "current title" is the live one — when a
  // connection exists the server re-reads it from WordPress rather than
  // trusting a manifest row from the last crawl.
  const contextQuery = useQuery({
    queryKey: ["rankloopRetitleContext", projectId, proposal.id],
    queryFn: () =>
      getRankloopRetitleContext({
        data: { projectId, proposalId: proposal.id },
      }),
  });
  const context = contextQuery.data;

  // Pre-fill the editor once with what is live now — editing beats retyping,
  // and S7's drafted titles will land in this same slot later.
  if (context && !prefilled) {
    setNewTitle(context.currentTitle ?? "");
    setNewMetaDescription(context.currentDescription ?? "");
    setPrefilled(true);
  }

  const winningQueries = retitleWinningQueries(proposal.evidence);

  const applyMutation = useMutation({
    mutationFn: () =>
      executeRetitleProposal({
        data: {
          projectId,
          proposalId: proposal.id,
          newTitle: newTitle.trim(),
          newMetaDescription: newMetaDescription.trim() || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopProposals", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopReceipts", projectId],
      });
      toast.success("Title applied");
      onClose();
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't apply the title. Try again."),
      );
    },
  });

  return (
    <Modal
      onClose={onClose}
      labelledBy="apply-retitle-title"
      maxWidth="max-w-lg"
    >
      <h3 id="apply-retitle-title" className="text-lg font-semibold">
        Apply new title to {proposal.target}?
      </h3>
      <p className="text-sm text-base-content/70">
        The body and publish date stay untouched.
      </p>

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Current title
        </p>
        {contextQuery.isPending ? (
          <div aria-busy className="skeleton h-5 w-3/4" />
        ) : (
          <p className="text-sm">
            {context?.currentTitle ?? (
              <span className="text-base-content/40">—</span>
            )}
          </p>
        )}
      </div>

      {winningQueries.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Winning queries
          </p>
          <div className="flex flex-wrap gap-1.5">
            {winningQueries.map((entry) => (
              <span
                key={entry.query}
                title={entry.detail}
                className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${tagChipClass("slate")}`}
              >
                {entry.query}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="flex items-baseline justify-between">
          <span className="font-medium">New title</span>
          <CharCount length={newTitle.length} hint={TITLE_LENGTH_HINT} />
        </span>
        <input
          type="text"
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          className="input input-bordered w-full"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="flex items-baseline justify-between">
          <span className="font-medium">
            Meta description{" "}
            <span className="text-base-content/50">(optional)</span>
          </span>
          <CharCount
            length={newMetaDescription.length}
            hint={META_LENGTH_HINT}
          />
        </span>
        <textarea
          value={newMetaDescription}
          onChange={(event) => setNewMetaDescription(event.target.value)}
          rows={3}
          className="textarea textarea-bordered w-full"
        />
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={newTitle.trim() === "" || applyMutation.isPending}
          onClick={() => applyMutation.mutate()}
        >
          {applyMutation.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          Apply title
        </button>
      </div>
    </Modal>
  );
}
