import { useQuery } from "@tanstack/react-query";
import { formatDay } from "@/client/features/dashboard/cardParts";
import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import {
  decidedByLabel,
  formatClicksDelta,
  formatReceiptPosition,
  receiptAdjustedClicksDelta,
  receiptClicksDelta,
  receiptClicksTone,
  receiptStatusDisplay,
} from "@/client/features/rankloop-receipts/receiptDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getRankloopReceipts } from "@/serverFunctions/rankloopReceipts";
import { tagChipClass, tagDotClass } from "@/shared/tag-colors";

type ReceiptRow = Awaited<ReturnType<typeof getRankloopReceipts>>[number];

// Same chip anatomy as the proposals table (TagChip's xs size) so action and
// status chips read as one system across the Write screens.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium";

function ActionChip({ actionType }: { actionType: string }) {
  const display = proposalTypeDisplay(actionType);
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${tagDotClass(display.color)}`}
      />
      {display.label}
    </span>
  );
}

// Who decided the action, next to what the action was. Deliberately the
// neutral chip and not a tag colour: the action chip's colour already encodes
// which signal fired, and a second coloured pill beside it would make the two
// compete for the same glance. Provenance is a fact, not a severity.
function DecidedByChip({ decidedBy }: { decidedBy: string | null }) {
  const label = decidedByLabel(decidedBy);
  if (label === null) return null;
  return (
    <span
      className={`${chipBaseClass} bg-base-300 text-base-content/70`}
      title={
        label === "autopilot"
          ? "rankloop approved and executed this one without a human"
          : "a person approved this one"
      }
    >
      {label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const display = receiptStatusDisplay(status);
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      {display.label}
    </span>
  );
}

// Mirrors the loaded layout — header row over table rows inside the panel —
// so the shell stays put and only the data fills in.
function ReceiptsLoadingState() {
  return (
    <div
      aria-busy
      className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
    >
      <div className="space-y-3 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="skeleton h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

function ReceiptRowCells({ row }: { row: ReceiptRow }) {
  const delta = receiptClicksDelta(row.baseline, row.result);
  const adjusted = receiptAdjustedClicksDelta(row.result);
  // The second line appears only when the site-wide trend actually moved the
  // answer. A window with nothing to drift against (a zero-click site or page
  // baseline) leaves the adjustment equal to the raw count, and printing the
  // same number twice is how a screen teaches people to stop reading it.
  const showAdjusted = adjusted !== null && adjusted !== delta;
  return (
    <tr>
      <td>
        <span className="flex flex-wrap items-center gap-1.5">
          <ActionChip actionType={row.actionType} />
          <DecidedByChip decidedBy={row.decidedBy} />
        </span>
      </td>
      <td>
        <span
          className="block max-w-xs truncate font-mono text-xs"
          title={row.target}
        >
          {row.target}
        </span>
      </td>
      <td className="text-base-content/70">{formatDay(row.createdAt)}</td>
      <td>
        <StatusChip status={row.status} />
      </td>
      <td className="text-right">
        <span className="font-mono text-xs text-base-content/40">
          {formatReceiptPosition(row.baseline?.weightedPosition ?? null)}
        </span>
        <span className="mx-1 text-base-content/30">→</span>
        <span
          className={
            row.result
              ? "font-mono text-xs font-semibold"
              : "font-mono text-xs text-base-content/40"
          }
        >
          {formatReceiptPosition(row.result?.weightedPosition ?? null)}
        </span>
      </td>
      <td
        className={`text-right tabular-nums ${receiptClicksTone(delta, adjusted)}`}
      >
        {formatClicksDelta(delta)}
        {showAdjusted ? (
          <span className="block text-[11px] font-normal text-base-content/50">
            {formatClicksDelta(adjusted)} adjusted
          </span>
        ) : null}
      </td>
    </tr>
  );
}

export function RankloopReceiptsPanel({ projectId }: { projectId: string }) {
  const receiptsQuery = useQuery({
    queryKey: ["rankloopReceipts", projectId],
    queryFn: () => getRankloopReceipts({ data: { projectId } }),
  });

  if (receiptsQuery.isPending) return <ReceiptsLoadingState />;

  if (receiptsQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(receiptsQuery.error)}
        </span>
      </div>
    );
  }

  const rows = receiptsQuery.data;

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-base-content/60">
          No receipts yet — approve and apply a proposal to start one.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>Executed</th>
                <th>Status</th>
                <th className="text-right">Position</th>
                <th className="text-right">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ReceiptRowCells key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Names which number carries the adjustment. The old wording —
          "results trend-adjusted against your site" — was true of nothing on
          screen: the clicks cell printed the raw delta and the positions are
          weighted but never drift-corrected, so the one screen whose job is
          honesty was over-claiming in its own footer. */}
      <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
        positions are impressions-weighted · adjusted clicks divide out your
        site-wide trend
      </p>
    </div>
  );
}
