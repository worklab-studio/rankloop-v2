import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { formatDay } from "@/client/features/dashboard/cardParts";
import {
  coverageDisplay,
  formatCount,
  formatTraffic,
} from "@/client/features/rankloop-plan/competitorDisplay.logic";
import type { getRankloopCompetitors } from "@/serverFunctions/rankloopCompetitors";
import { tagChipClass } from "@/shared/tag-colors";

type CompetitorRow = Awaited<
  ReturnType<typeof getRankloopCompetitors>
>["tracked"][number];

// Chip anatomy mirrors TagChip's xs size (h-5 px-1.5 text-[11px]) so coverage
// reads as the same system as the proposal and receipt chips.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

function CoverageChip({ coverage }: { coverage: string | null }) {
  const display = coverageDisplay(coverage);
  if (!display) return <span className="text-base-content/40">—</span>;
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      {display.label}
    </span>
  );
}

// Study state as the house run badge: a spinner while the workflow runs, a
// failure badge when it died, and nothing at all once it is done — coverage
// and the last-studied stamp already say so, and a "done" badge on every row
// would be noise.
function StudyStatusCell({ status }: { status: string | null }) {
  if (status === "pending" || status === "running") {
    return (
      <span className="badge badge-info badge-sm gap-1">
        <Loader2 className="size-3 animate-spin" />
        Studying
      </span>
    );
  }
  if (status === "error") {
    return <span className="badge badge-error badge-sm">Failed</span>;
  }
  return null;
}

export function RankloopCompetitorsTable({
  projectId,
  rows,
}: {
  projectId: string;
  rows: CompetitorRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Domain</th>
            <th className="text-right">Domain rank</th>
            <th className="text-right">Est. traffic</th>
            <th className="text-right">Pages</th>
            <th>Coverage</th>
            <th>Last studied</th>
            <th aria-label="Study status" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link
                  to="/p/$projectId/plan/competitors/$competitorId"
                  params={{ projectId, competitorId: row.id }}
                  className="link link-hover font-medium"
                >
                  {row.domain}
                </Link>
              </td>
              <td className="text-right tabular-nums">
                {row.domainRank === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  row.domainRank.toLocaleString("en-US")
                )}
              </td>
              <td className="text-right tabular-nums">
                {row.estTraffic === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  formatTraffic(row.estTraffic)
                )}
              </td>
              <td className="text-right tabular-nums">
                {row.pagesStudied === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  formatCount(row.pagesStudied)
                )}
              </td>
              <td>
                <CoverageChip coverage={row.coverage} />
              </td>
              <td className="text-base-content/70">
                {row.lastStudiedAt === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  formatDay(row.lastStudiedAt)
                )}
              </td>
              <td>
                <StudyStatusCell status={row.studyStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
