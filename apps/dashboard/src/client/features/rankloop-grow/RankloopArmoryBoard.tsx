import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopArmory,
  seedRankloopArmory,
  verifyRankloopLinks,
} from "@/serverFunctions/rankloopArmory";
import { RankloopSubmissionKitModal } from "@/client/features/rankloop-grow/RankloopSubmissionKitModal";
import { renderPayload, type SubmissionKit } from "@/shared/submission-kit";
import type { ArmoryRow } from "@/server/features/rankloop/outreach/services/ArmoryService";

// The Grow board (spec 0029): every place that could link to you or list
// you, ranked by what you can actually win.

const chip =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium";

const LANE_LABEL: Record<string, string> = {
  seed: "Directory",
  serp: "Roundup",
  backlink_submit: "Accepts listings",
  link_gap: "Links to competitors",
};

const STATUS_LABEL: Record<string, string> = {
  to_contact: "Not started",
  sent: "Submitted",
  replied: "Replied",
  linked: "Live",
  declined: "Declined",
};

function StatusChip({ row }: { row: ArmoryRow }) {
  if (row.status === "linked") {
    return (
      <span className={`${chip} bg-success/15 text-success`}>
        <Check className="size-3" />
        Live
      </span>
    );
  }
  return (
    <span className={`${chip} bg-base-300 text-base-content/70`}>
      {STATUS_LABEL[row.status] ?? row.status}
    </span>
  );
}

/** One field of the prepared listing, with its own copy button. Directory
 *  forms are filled box by box, so the payload is copied box by box. */
function PayloadField({
  field,
}: {
  field: { label: string; value: string; truncated: boolean; limit: number | null };
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 border-b border-base-300/60 py-1.5 last:border-b-0">
      <span className="w-32 shrink-0 pt-0.5 text-[11px] text-base-content/50">
        {field.label}
        {field.truncated ? (
          <span className="ml-1 text-warning" title="Shortened at a word boundary to fit">
            shortened
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 text-xs">{field.value}</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs shrink-0 gap-1"
        onClick={() => {
          void navigator.clipboard.writeText(field.value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function TargetRow({ row, kit }: { row: ArmoryRow; kit: SubmissionKit | null }) {
  const [open, setOpen] = useState(false);
  const fields = open && kit ? renderPayload(kit) : [];

  return (
    <li className="border-b border-base-300 last:border-b-0">
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="w-10 shrink-0 pt-0.5 text-right text-sm tabular-nums text-base-content/50">
        {row.score.toFixed(1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {row.seedName ?? row.domain}
          </span>
          <span className={`${chip} bg-base-300 text-base-content/60`}>
            {LANE_LABEL[row.lane] ?? row.lane}
          </span>
          <StatusChip row={row} />
        </span>
        {/* The reason this row is on the board, in the user's words. A target
            that cannot say why it is a target is a guess. */}
        <span className="mt-0.5 block text-xs text-base-content/60">
          {row.why}
        </span>
        {row.seedCheckedAt ? (
          <span className="mt-0.5 block text-[11px] text-base-content/40">
            {row.seedUrlConfirmed
              ? `Submission page checked ${row.seedCheckedAt}`
              : `Site checked ${row.seedCheckedAt} — it blocks automated requests, so the exact submission page is unconfirmed`}
          </span>
        ) : null}
        {row.linkLiveAt ? (
          <span className="mt-0.5 block text-[11px] text-success">
            Link found {new Date(row.linkLiveAt).toLocaleDateString()}
            {row.verifiedUrl ? ` on ${row.verifiedUrl}` : ""}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {kit ? (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Listing"}
          </button>
        ) : null}
        {row.submissionUrl ? (
          <a
            href={row.submissionUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-xs gap-1"
          >
            Open
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </span>
    </div>

    {open && kit ? (
      <div className="border-t border-base-300 bg-base-200/40 px-4 py-2">
        {fields.map((field) => (
          <PayloadField key={field.label} field={field} />
        ))}
      </div>
    ) : null}
    </li>
  );
}

export function RankloopArmoryBoard({ projectId }: { projectId: string }) {
  const [kitOpen, setKitOpen] = useState(false);
  const queryClient = useQueryClient();
  const boardQuery = useQuery({
    queryKey: ["rankloopArmory", projectId],
    queryFn: () => getRankloopArmory({ data: { projectId } }),
  });

  const setBoard = (board: unknown) =>
    queryClient.setQueryData(["rankloopArmory", projectId], board);

  const seed = useMutation({
    mutationFn: () => seedRankloopArmory({ data: { projectId } }),
    onSuccess: setBoard,
  });
  const verify = useMutation({
    mutationFn: () => verifyRankloopLinks({ data: { projectId } }),
    onSuccess: (result) => setBoard(result.board),
  });

  if (boardQuery.isPending) {
    return <div className="skeleton h-64 rounded-xl" />;
  }
  if (boardQuery.isError) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm">
        {getStandardErrorMessage(boardQuery.error)}
      </div>
    );
  }

  const board = boardQuery.data;
  const live = board.rows.filter((r) => r.status === "linked").length;

  // First run: a button and a sentence, not an empty table. An empty table
  // under this heading reads as "we looked and there is nowhere to get
  // links", which is a different and false claim.
  if (board.rows.length === 0) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-100 p-6">
        <p className="text-sm font-medium">Nothing on the board yet</p>
        <p className="mt-1 max-w-xl text-sm text-base-content/70">
          rankloop ships a checked list of places that accept product
          listings, and adds more from the pages your competitors are already
          linked from. It prepares each submission; you send it.
        </p>
        <button
          type="button"
          className="btn btn-sm mt-4 gap-1.5"
          disabled={seed.isPending}
          onClick={() => seed.mutate()}
        >
          <Sparkles className="size-3.5" />
          {seed.isPending ? "Adding…" : "Build my list"}
        </button>
        {seed.isError ? (
          <p className="mt-2 text-xs text-error">
            {getStandardErrorMessage(seed.error)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-base-content/70">
          {board.rows.length} places · {live} live
          <span className="text-base-content/40">
            {" · directory list checked "}
            {board.seedCheckedAt}
          </span>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-sm gap-1.5"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
            title="Re-fetch each page and look for a link to your site"
          >
            <RefreshCw className={`size-3.5 ${verify.isPending ? "animate-spin" : ""}`} />
            Check for live links
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={seed.isPending}
            onClick={() => seed.mutate()}
          >
            Add more
          </button>
        </div>
      </div>

      {verify.isSuccess ? (
        <p className="text-xs text-base-content/60">
          Checked {verify.data.checked} pages
          {verify.data.nowLive > 0
            ? ` · found ${verify.data.nowLive} new live link${verify.data.nowLive === 1 ? "" : "s"}`
            : " · no new links yet"}
        </p>
      ) : null}

      {board.kitGaps.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-warning">
              Your submission kit still needs {board.kitGaps.join(", ")}
            </p>
            <p className="mt-0.5 text-xs text-base-content/60">
              Fill it once and every listing below is pre-written to that
              directory&rsquo;s length limits.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setKitOpen(true)}
          >
            Fill it in
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-base-content/50">
            Listings render from your submission kit.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setKitOpen(true)}
          >
            Edit kit
          </button>
        </div>
      )}

      <ul className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        {board.rows.map((row) => (
          <TargetRow key={row.id} row={row} kit={board.kit} />
        ))}
      </ul>

      {kitOpen ? (
        <RankloopSubmissionKitModal
          projectId={projectId}
          kit={board.kit}
          defaults={board.kitDefaults}
          onClose={() => setKitOpen(false)}
        />
      ) : null}
    </div>
  );
}
