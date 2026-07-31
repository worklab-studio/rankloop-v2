import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { TablePagination } from "@/client/components/table/TablePagination";
import { DifficultyBadge } from "@/client/features/domain/components/DifficultyBadge";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getRankloopPageTypeInstances } from "@/serverFunctions/rankloopPagePlan";

// Ten rows keeps the list inside the card it opened from — this is the proof
// that a type is real, not a table anyone works in. The larger sizes are for
// the founder who wants to read the whole shape before approving it.
const INSTANCE_PAGE_SIZES = [10, 25, 50] as const;

type InstanceRow = Awaited<
  ReturnType<typeof getRankloopPageTypeInstances>
>["rows"][number];

function InstanceRows({ rows }: { rows: InstanceRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Keyword</th>
            <th className="text-right">Volume</th>
            <th className="text-right">KD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="max-w-sm truncate" title={row.keyword}>
                {row.keyword}
              </td>
              <td className="text-right tabular-nums">
                {row.searchVolume === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  row.searchVolume.toLocaleString("en-US")
                )}
              </td>
              <td>
                <span className="flex justify-end">
                  <DifficultyBadge value={row.keywordDifficulty} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every keyword the planner bound to this type. Fetched on its own rather than
 * shipped inside the plan payload: a pSEO type can carry hundreds of rows and
 * the tab renders every card at once, so the list only costs a query once
 * someone opens the drawer to check it.
 */
export function RankloopPageTypeInstances({
  projectId,
  pageTypeId,
}: {
  projectId: string;
  pageTypeId: string;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(INSTANCE_PAGE_SIZES[0]);

  const instancesQuery = useQuery({
    queryKey: [
      "rankloopPageTypeInstances",
      projectId,
      pageTypeId,
      page,
      pageSize,
    ],
    queryFn: () =>
      getRankloopPageTypeInstances({
        data: { projectId, pageTypeId, page, pageSize },
      }),
    placeholderData: keepPreviousData,
  });

  if (instancesQuery.isPending) {
    return (
      <div aria-busy className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skeleton h-6 w-full" />
        ))}
      </div>
    );
  }

  if (instancesQuery.isError) {
    return (
      <p className="text-sm text-base-content/60">
        {getStandardErrorMessage(
          instancesQuery.error,
          "Couldn't load these keywords. Try again shortly.",
        )}
      </p>
    );
  }

  const { rows, totalCount } = instancesQuery.data;

  return (
    <div className="overflow-hidden rounded-lg border border-base-300 bg-base-100">
      <InstanceRows rows={rows} />
      <TablePagination
        page={page}
        pageSize={pageSize}
        pageSizes={INSTANCE_PAGE_SIZES}
        totalCount={totalCount}
        hasNextPage={page * pageSize < totalCount}
        isLoading={instancesQuery.isFetching}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
    </div>
  );
}
