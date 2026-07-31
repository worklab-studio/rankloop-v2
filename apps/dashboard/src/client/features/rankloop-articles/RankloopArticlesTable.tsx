import { Link } from "@tanstack/react-router";
import { failedLaws } from "@/client/features/rankloop-articles/articleDisplay.logic";
import { formatCost } from "@/client/features/rankloop-articles/netNewDisplay.logic";
import { StatusDot } from "@/client/features/rankloop-articles/RankloopArticleReport";
import { ArticleStatusBadge } from "@/client/features/rankloop-articles/RankloopArticleStatus";
import type { getRankloopArticles } from "@/serverFunctions/rankloopWriter";

type ArticleRow = Awaited<ReturnType<typeof getRankloopArticles>>[number];

/** The grade in one cell: a dot for the verdict, "9 of 12" for the margin.
 *  A row with no report yet renders "—" rather than "0 of 0", which would
 *  read as a perfect score for a draft nobody has checked. */
function LawsCell({ report }: { report: ArticleRow["lawReport"] }) {
  if (!report || report.length === 0) {
    return <span className="text-base-content/40">&mdash;</span>;
  }
  const failed = failedLaws(report).length;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot passed={failed === 0} />
      <span className="tabular-nums">
        {report.length - failed} of {report.length}
      </span>
    </span>
  );
}

export function RankloopArticlesTable({
  rows,
  projectId,
}: {
  rows: ArticleRow[];
  projectId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Article</th>
            <th>Status</th>
            <th>Laws</th>
            <th className="text-right">Attempts</th>
            <th className="text-right">Cost</th>
            <th className="text-right" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.title ? (
                  <>
                    <span
                      className="block max-w-md truncate font-medium"
                      title={row.title}
                    >
                      {row.title}
                    </span>
                    <span
                      className="block max-w-md truncate font-mono text-xs text-base-content/50"
                      title={row.keyword}
                    >
                      {row.keyword}
                    </span>
                  </>
                ) : (
                  <span
                    className="block max-w-md truncate font-mono"
                    title={row.keyword}
                  >
                    {row.keyword}
                  </span>
                )}
              </td>
              <td>
                <ArticleStatusBadge
                  status={row.status}
                  lawReport={row.lawReport}
                />
              </td>
              <td className="text-sm">
                <LawsCell report={row.lawReport} />
              </td>
              <td className="text-right tabular-nums">{row.attempts}</td>
              <td className="text-right tabular-nums">
                {/* Agent-mode articles genuinely have no dollar figure; "—"
                    says that, "$0.00" would claim the writing was free. */}
                {row.costUsd === null ? (
                  <span className="text-base-content/40">&mdash;</span>
                ) : (
                  formatCost(row.costUsd)
                )}
              </td>
              <td className="text-right">
                <Link
                  to="/p/$projectId/articles/$articleId"
                  params={{ projectId, articleId: row.id }}
                  className="btn btn-ghost btn-sm"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
