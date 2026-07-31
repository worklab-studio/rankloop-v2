import { useQuery } from "@tanstack/react-query";
import { formatDay } from "@/client/features/dashboard/cardParts";
import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import {
  formatClicksDelta,
  formatReceiptPosition,
  receiptClicksDelta,
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
  return (
    <tr>
      <td>
        <ActionChip actionType={row.actionType} />
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
        className={`text-right tabular-nums ${
          delta === null
            ? "text-base-content/40"
            : delta > 0
              ? "text-success"
              : delta < 0
                ? "text-error"
                : ""
        }`}
      >
        {formatClicksDelta(delta)}
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
      <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
        positions are impressions-weighted · results trend-adjusted against your
        site
      </p>
    </div>
  );
}
