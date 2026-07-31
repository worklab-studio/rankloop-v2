import { useMemo } from "react";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  AppDataTable,
  makeSelectionColumn,
  useAppTable,
  useSelectionAnchor,
} from "@/client/components/table/AppDataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { TablePagination } from "@/client/components/table/TablePagination";
import {
  clusterLabel,
  formatMetric,
  formatScore,
  sourceDisplay,
  statusLabel,
} from "@/client/features/rankloop-plan/keywordUniverseDisplay.logic";
import { scoreTierClass } from "@/client/features/keywords/utils";
import { tagChipClass } from "@/shared/tag-colors";
import { BACKLOG_PAGE_SIZES } from "@/types/schemas/rankloopUniverse";
import type { getRankloopBacklog } from "@/serverFunctions/rankloopUniverse";

type BacklogRow = Awaited<
  ReturnType<typeof getRankloopBacklog>
>["rows"][number];

const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

// The same tiered badge keyword research uses for difficulty, so a KD of 34
// is the same colour everywhere in the app. Null keeps the em dash rather
// than the na tier's grey circle: an unmeasured keyword has no difficulty,
// and a badge would imply somebody looked.
function DifficultyCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-base-content/40">—</span>;
  return (
    <span
      className={`score-badge ${scoreTierClass(
        value,
      )} inline-flex size-6 items-center justify-center rounded-full text-[10px] font-semibold`}
    >
      {value}
    </span>
  );
}

function SourceCell({ source }: { source: string }) {
  const display = sourceDisplay(source);
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      {display.label}
    </span>
  );
}

function buildColumns(
  anchorRef: ReturnType<typeof useSelectionAnchor>,
): ColumnDef<BacklogRow>[] {
  return [
    makeSelectionColumn<BacklogRow>(anchorRef),
    {
      id: "keyword",
      accessorKey: "keyword",
      header: ({ column }) => (
        <SortableHeader column={column} label="Keyword" />
      ),
      cell: ({ row }) => (
        <span className="font-medium">{row.original.keyword}</span>
      ),
    },
    {
      id: "searchVolume",
      accessorKey: "searchVolume",
      header: ({ column }) => (
        <SortableHeader column={column} label="Volume" align="right" />
      ),
      meta: { headerClassName: "text-right", cellClassName: "text-right" },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMetric(row.original.searchVolume)}
        </span>
      ),
    },
    {
      id: "keywordDifficulty",
      accessorKey: "keywordDifficulty",
      header: ({ column }) => (
        <SortableHeader column={column} label="KD" align="right" />
      ),
      meta: { headerClassName: "text-right", cellClassName: "text-right" },
      cell: ({ row }) => (
        <DifficultyCell value={row.original.keywordDifficulty} />
      ),
    },
    {
      id: "intent",
      accessorKey: "intent",
      enableSorting: false,
      header: "Intent",
      cell: ({ row }) =>
        row.original.intent ? (
          <span className="text-base-content/70">{row.original.intent}</span>
        ) : (
          <span className="text-base-content/40">—</span>
        ),
    },
    {
      id: "score",
      accessorKey: "score",
      header: ({ column }) => (
        <SortableHeader column={column} label="Score" align="right" />
      ),
      meta: { headerClassName: "text-right", cellClassName: "text-right" },
      cell: ({ row }) => (
        <span className="tabular-nums">{formatScore(row.original.score)}</span>
      ),
    },
    {
      id: "source",
      accessorKey: "source",
      enableSorting: false,
      header: "Source",
      cell: ({ row }) => <SourceCell source={row.original.source} />,
    },
    {
      id: "status",
      accessorKey: "status",
      enableSorting: false,
      header: "Status",
      cell: ({ row }) => (
        <span className="badge badge-ghost badge-sm">
          {statusLabel(row.original.status)}
        </span>
      ),
    },
    {
      id: "cluster",
      accessorKey: "clusterKey",
      enableSorting: false,
      header: "Cluster",
      cell: ({ row }) => (
        <span className="text-base-content/60">
          {clusterLabel(row.original.clusterKey)}
        </span>
      ),
    },
  ];
}

function BacklogEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-10 text-center text-sm text-base-content/55">
      {filtered
        ? "No keywords match this filter."
        : "Nothing in the backlog yet — run a source above and every candidate that passes your gate lands here."}
    </div>
  );
}

function BacklogLoadingRows() {
  return (
    <div className="space-y-2 p-4" aria-busy>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="skeleton h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * The backlog itself. Sorting and paging are server-side — the backlog runs to
 * thousands of rows and a client sort would only ever order the page you can
 * already see, which reads as a broken column rather than a fast one.
 */
export function RankloopBacklogTable({
  rows,
  totalCount,
  page,
  pageSize,
  sorting,
  rowSelection,
  isLoading,
  isFetching,
  filtered,
  onSortingChange,
  onRowSelectionChange,
  onPageChange,
  onPageSizeChange,
}: {
  rows: BacklogRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  sorting: SortingState;
  rowSelection: RowSelectionState;
  isLoading: boolean;
  isFetching: boolean;
  filtered: boolean;
  onSortingChange: OnChangeFn<SortingState>;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onPageChange: (next: number) => void;
  onPageSizeChange: (next: number) => void;
}) {
  const anchorRef = useSelectionAnchor();
  const columns = useMemo(() => buildColumns(anchorRef), [anchorRef]);

  const table = useAppTable<BacklogRow>({
    data: rows,
    columns,
    state: { sorting, rowSelection },
    // The server has already sorted and paged; letting the table re-sort would
    // reorder one page against a different rule than the other pages used.
    manualSorting: true,
    manualPagination: true,
    getRowId: (row) => row.id,
    onSortingChange,
    onRowSelectionChange,
    enableRowSelection: true,
  });

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <AppDataTable
        table={table}
        isLoading={isLoading}
        loading={<BacklogLoadingRows />}
        empty={<BacklogEmptyState filtered={filtered} />}
        stickyHeader
      />
      {rows.length > 0 ? (
        <TablePagination
          page={page}
          pageSize={pageSize}
          pageSizes={BACKLOG_PAGE_SIZES}
          totalCount={totalCount}
          hasNextPage={page * pageSize < totalCount}
          isLoading={isFetching}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      ) : null}
    </div>
  );
}
