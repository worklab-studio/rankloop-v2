import { Loader2, PenLine } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import { writeCostLine } from "@/client/features/rankloop-articles/articleDisplay.logic";
import { formatCost } from "@/client/features/rankloop-articles/netNewDisplay.logic";
import type { getRankloopWriterAccess } from "@/serverFunctions/rankloopWriter";

type WriterAccess = Awaited<ReturnType<typeof getRankloopWriterAccess>>;

/**
 * The price, stated before anything is generated.
 *
 * A choice card rather than an OK dialog, the CheckConfirmModal shape: the
 * math line above spells out the ceiling, and the button repeats it, because
 * the fix loop can spend three times what the first draft costs and finding
 * that out afterwards would be a betrayal.
 */
export function RankloopWriteConfirmModal({
  access,
  target,
  title,
  isPending,
  onConfirm,
  onCancel,
}: {
  access: WriterAccess;
  target: string;
  title: string | null;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ceiling = formatCost(
    access.estimatedAttemptCostUsd * access.maxAttempts,
  );

  return (
    <Modal
      maxWidth="max-w-md"
      onClose={onCancel}
      labelledBy="rankloop-write-confirm-title"
    >
      <div className="min-w-0">
        <h3 id="rankloop-write-confirm-title" className="text-lg font-semibold">
          Write this post?
        </h3>
        <p
          className="mt-1 truncate text-sm text-base-content/70"
          title={title ?? target}
        >
          {title ?? target}
        </p>
        <p className="mt-1 text-sm text-base-content/60">
          {writeCostLine(access.estimatedAttemptCostUsd, access.maxAttempts)}
        </p>
      </div>

      <button
        type="button"
        className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
        disabled={isPending}
        onClick={onConfirm}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <PenLine className="size-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium">Write the draft</p>
          <p className="text-xs text-base-content/60">
            One generation, then the laws. Repairs only if it fails.
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono font-semibold">{ceiling}</p>
          {isPending ? (
            <Loader2 className="ml-auto size-3 animate-spin" />
          ) : null}
        </div>
      </button>

      {/* The boundary, said where the money is spent: rankloop grades the
          draft, it never asks a second model whether the first one was good
          enough — so every dollar here bought words, not opinions. */}
      <p className="text-[11px] text-base-content/45">
        {access.model} on your OpenRouter key &middot; every call is recorded
        with its tokens &middot; the laws that judge the draft cost nothing
      </p>

      <button
        type="button"
        className="btn btn-ghost btn-sm self-center"
        onClick={onCancel}
      >
        Cancel
      </button>
    </Modal>
  );
}
