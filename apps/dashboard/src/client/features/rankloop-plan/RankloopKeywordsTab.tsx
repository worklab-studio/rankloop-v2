import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { Loader2, SkipForward } from "lucide-react";
import { toast } from "sonner";
import {
  TableBulkActionBar,
  TableBulkActionButton,
} from "@/client/components/table/TableBulkActionBar";
import { RankloopBacklogTable } from "@/client/features/rankloop-plan/RankloopBacklogTable";
import { RankloopGateCard } from "@/client/features/rankloop-plan/RankloopGateCard";
import { RankloopKeywordSources } from "@/client/features/rankloop-plan/RankloopKeywordSources";
import {
  sourceLabel,
  universeStamp,
} from "@/client/features/rankloop-plan/keywordUniverseDisplay.logic";
import { useKeywordUniversePolling } from "@/client/features/rankloop-plan/useKeywordUniversePolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopBacklog,
  getRankloopGate,
  rederiveRankloopGate,
  skipRankloopKeywords,
  startRankloopUniverse,
  updateRankloopGate,
} from "@/serverFunctions/rankloopUniverse";
import {
  BACKLOG_SOURCES,
  type HarvestConfig,
  type KeywordBacklogSource,
  type UniverseSource,
} from "@/types/schemas/rankloopUniverse";

// The house search debounce. 350ms is long enough that typing "espresso"
// costs one query instead of eight, short enough that the table doesn't feel
// like it is thinking about it.
const FILTER_DEBOUNCE_MS = 350;

const EMPTY_HARVEST: HarvestConfig = {
  stackExchangeTags: [],
  subreddits: [],
};

function SourceFilterRow({
  counts,
  selected,
  onToggle,
  onClear,
}: {
  counts: Map<string, number>;
  selected: KeywordBacklogSource[];
  onToggle: (source: KeywordBacklogSource) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {BACKLOG_SOURCES.map((source) => {
        const active = selected.includes(source);
        const total = counts.get(source) ?? 0;
        return (
          <button
            key={source}
            type="button"
            aria-pressed={active}
            className={`btn btn-xs ${active ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onToggle(source)}
          >
            {sourceLabel(source)}
            <span className="tabular-nums opacity-60">
              {total.toLocaleString("en-US")}
            </span>
          </button>
        );
      })}
      {selected.length > 0 ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={onClear}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

export function RankloopKeywordsTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const runQuery = useKeywordUniversePolling(projectId);

  const [harvest, setHarvest] = useState<HarvestConfig>(EMPTY_HARVEST);
  const [selectedSources, setSelectedSources] = useState<
    KeywordBacklogSource[]
  >([]);
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "score", desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCommittedSearch(search);
      setPage(1);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The last harvesting run is the record of how harvesting was configured, so
  // the panel prefills from it rather than asking a returning user twice.
  const storedHarvest = runQuery.data?.harvest ?? null;
  useEffect(() => {
    if (storedHarvest) setHarvest(storedHarvest);
  }, [storedHarvest]);

  const sortState = sorting[0];
  const queryInput = useMemo(
    () => ({
      projectId,
      ...(selectedSources.length > 0 ? { sources: selectedSources } : {}),
      ...(committedSearch.trim() ? { search: committedSearch.trim() } : {}),
      page,
      pageSize,
      sort: toBacklogSort(sortState?.id),
      // Descending is the default for every column here: an unsorted table and
      // a score-sorted one show the same first row, so a click that landed on
      // ascending would look like nothing happened.
      order:
        sortState && !sortState.desc ? ("asc" as const) : ("desc" as const),
    }),
    [committedSearch, page, pageSize, projectId, selectedSources, sortState],
  );

  const backlogQuery = useQuery({
    queryKey: ["rankloopBacklog", projectId, queryInput],
    queryFn: () => getRankloopBacklog({ data: queryInput }),
    placeholderData: keepPreviousData,
  });

  const gateQuery = useQuery({
    queryKey: ["rankloopGate", projectId],
    queryFn: () => getRankloopGate({ data: { projectId } }),
  });

  const invalidateBacklog = () =>
    queryClient.invalidateQueries({ queryKey: ["rankloopBacklog", projectId] });
  const invalidateGate = () =>
    queryClient.invalidateQueries({ queryKey: ["rankloopGate", projectId] });

  const startMutation = useMutation({
    mutationFn: (source: UniverseSource) =>
      startRankloopUniverse({
        data: {
          projectId,
          sources: [source],
          ...(source === "harvest" ? { harvest } : {}),
        },
      }),
    onSuccess: (result) => {
      if (result.alreadyRunning) toast.info("A keyword run is already running");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't start that source."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopUniverseRun", projectId],
      });
    },
  });

  const gateMutation = useMutation({
    mutationFn: (input: { positives: string[]; negatives: string[] }) =>
      updateRankloopGate({ data: { projectId, ...input } }),
    onSuccess: () => {
      toast.success(
        "Gate saved — re-derivation will leave it alone from now on",
      );
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Couldn't save the gate."));
    },
    onSettled: () => {
      void invalidateGate();
    },
  });

  const rederiveMutation = useMutation({
    mutationFn: () => rederiveRankloopGate({ data: { projectId } }),
    onSuccess: (result) => {
      toast[result.derived ? "success" : "info"](
        result.derived
          ? "Gate re-derived from your pages and queries"
          : "Nothing re-derived — this gate has been edited by hand",
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't re-derive the gate."),
      );
    },
    onSettled: () => {
      void invalidateGate();
    },
  });

  const skipMutation = useMutation({
    mutationFn: (keywordIds: string[]) =>
      skipRankloopKeywords({ data: { projectId, keywordIds } }),
    onSuccess: (result) => {
      setRowSelection({});
      toast.success(
        `${result.skipped.toLocaleString("en-US")} keyword${
          result.skipped === 1 ? "" : "s"
        } skipped`,
      );
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Couldn't skip those rows."));
    },
    onSettled: () => {
      void invalidateBacklog();
    },
  });

  const latestRun = runQuery.data?.latestRun ?? null;
  const running =
    latestRun?.status === "pending" || latestRun?.status === "running";

  // The run query is the only thing polling, and the two queries that show
  // what a run produced — the backlog table and the gate card — are not it.
  // Without this the stamp flips to "312 passed your gate" over the rows that
  // were on screen before the run, and the gate card keeps saying the gate
  // will be derived the first time a source runs after it already has.
  //
  // Keyed on the run id rather than on a running→done edge because a local run
  // can start and settle inside one 3s poll interval, and this tab would never
  // see it running at all. The ref starts at whatever is already settled, so
  // mounting on an old run costs no refetch.
  const runId = latestRun?.id ?? null;
  const settled = runId !== null && !running;
  const settledRunId = useRef<string | null>(settled ? runId : null);
  useEffect(() => {
    if (!settled || settledRunId.current === runId) return;
    settledRunId.current = runId;
    void queryClient.invalidateQueries({
      queryKey: ["rankloopBacklog", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["rankloopGate", projectId],
    });
  }, [projectId, queryClient, runId, settled]);

  if (runQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(runQuery.error)}
        </span>
      </div>
    );
  }

  const rows = backlogQuery.data?.rows ?? [];
  const totalCount = backlogQuery.data?.totalCount ?? 0;
  const sourceCounts = new Map(
    (backlogQuery.data?.sourceCounts ?? []).map((row) => [
      row.source,
      row.value,
    ]),
  );
  const selectedIds = rows
    .filter((row) => rowSelection[row.id])
    .map((r) => r.id);
  const filtered = selectedSources.length > 0 || committedSearch.trim() !== "";

  return (
    <div className="space-y-4">
      <RankloopKeywordSources
        running={running}
        runningSources={runQuery.data?.sources?.sources ?? []}
        keyless={runQuery.data?.hasKeywordProvider === false}
        harvest={harvest}
        onHarvestChange={setHarvest}
        onStart={(source) => startMutation.mutate(source)}
      />

      {latestRun?.status === "error" ? (
        <div className="alert alert-error">
          <span className="text-sm">
            The last keyword run failed before it finished. Try that source
            again.
          </span>
        </div>
      ) : null}

      {gateQuery.data ? (
        <RankloopGateCard
          gate={gateQuery.data}
          saving={gateMutation.isPending}
          rederiving={rederiveMutation.isPending}
          onSave={(input) => gateMutation.mutate(input)}
          onRederive={() => rederiveMutation.mutate()}
        />
      ) : gateQuery.isSuccess ? (
        // No gate row yet. The first run derives one from the project's own
        // pages and queries, so the slot says that rather than rendering an
        // empty token list that would read as a gate admitting nothing.
        <p className="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/55">
          Your relevance gate is derived the first time a source runs &mdash;
          from your own pages and the queries you already earn impressions for.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceFilterRow
          counts={sourceCounts}
          selected={selectedSources}
          onToggle={(source) => {
            setSelectedSources((current) =>
              current.includes(source)
                ? current.filter((entry) => entry !== source)
                : [...current, source],
            );
            setPage(1);
          }}
          onClear={() => {
            setSelectedSources([]);
            setPage(1);
          }}
        />
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search keywords"
            className="input input-bordered input-sm w-56"
          />
          {backlogQuery.isFetching ? (
            <Loader2 className="size-4 animate-spin text-base-content/40" />
          ) : null}
        </div>
      </div>

      <RankloopBacklogTable
        rows={rows}
        totalCount={totalCount}
        page={page}
        pageSize={pageSize}
        sorting={sorting}
        rowSelection={rowSelection}
        isLoading={backlogQuery.isPending}
        isFetching={backlogQuery.isFetching}
        filtered={filtered}
        onSortingChange={(updater) => {
          setSorting((current) =>
            typeof updater === "function" ? updater(current) : updater,
          );
          setPage(1);
        }}
        onRowSelectionChange={setRowSelection}
        onPageChange={setPage}
        onPageSizeChange={(next) => {
          setPageSize(next);
          setPage(1);
        }}
      />

      <p className="text-[11px] text-base-content/45">
        {universeStamp(latestRun)}
      </p>

      <TableBulkActionBar
        selectedCount={selectedIds.length}
        onClear={() => setRowSelection({})}
        actions={
          <TableBulkActionButton
            icon={<SkipForward className="size-3.5" />}
            disabled={skipMutation.isPending}
            onClick={() => skipMutation.mutate(selectedIds)}
          >
            Skip selected
          </TableBulkActionButton>
        }
      />
    </div>
  );
}

// The table's column ids and the endpoint's sort names are the same words, but
// only four columns are sortable — anything else (a header that stops being
// sortable later, a stale URL) falls back to the default rather than 400ing.
function toBacklogSort(
  columnId: string | undefined,
): "score" | "keyword" | "searchVolume" | "keywordDifficulty" {
  switch (columnId) {
    case "keyword":
    case "searchVolume":
    case "keywordDifficulty":
      return columnId;
    default:
      return "score";
  }
}
