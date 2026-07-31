import { Link } from "@tanstack/react-router";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { formatDay } from "@/client/features/dashboard/cardParts";
import {
  linksInjectedLabel,
  publishedPath,
} from "@/client/features/rankloop-articles/publishPlan.logic";
import { receiptStatusDisplay } from "@/client/features/rankloop-receipts/receiptDisplay.logic";
import type { getRankloopPublishedArticles } from "@/serverFunctions/rankloopPublishArticle";
import { tagChipClass } from "@/shared/tag-colors";

type PublishedRow = Awaited<
  ReturnType<typeof getRankloopPublishedArticles>
>[number];

// Same chip anatomy as the receipts table, because it is the same receipt —
// the Published tab is where you notice one is still waiting for its window.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

function ReceiptChip({ status }: { status: string | null }) {
  // A published article with no receipt row is a real state: the post landed
  // on a page GSC has never reported on, so there is nothing to measure yet.
  if (!status) return <span className="text-base-content/40">&mdash;</span>;
  const display = receiptStatusDisplay(status);
  return (
    <span className={`${chipBaseClass} ${tagChipClass(display.color)}`}>
      {display.label}
    </span>
  );
}

function UrlCell({ row }: { row: PublishedRow }) {
  if (!row.url) {
    return <span className="text-base-content/40">&mdash;</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <SafeExternalLink
        url={row.url}
        label={publishedPath(row.url)}
        className="link link-hover inline-flex max-w-xs items-center gap-1 truncate font-mono text-xs"
      />
      {/* Webhook targets may not echo a URL back, in which case it was
          computed from the page type's pattern. Saying "unverified" is
          cheaper than showing a link that might 404. */}
      {row.urlConfidence === "unverified" ? (
        <span
          className="text-[11px] text-base-content/45"
          title="Computed from the page type's URL pattern — the target didn't confirm it."
        >
          unverified
        </span>
      ) : null}
    </span>
  );
}

export function RankloopPublishedTable({
  rows,
  projectId,
}: {
  rows: PublishedRow[];
  projectId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Article</th>
            <th>URL</th>
            <th>Hub</th>
            <th className="text-right">Links injected</th>
            <th>Receipt</th>
            <th className="text-right" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <span
                  className="block max-w-xs truncate font-medium"
                  title={row.title ?? row.keyword}
                >
                  {row.title ?? row.keyword}
                </span>
                <span className="block text-xs text-base-content/50">
                  published {formatDay(row.publishedAt)}
                </span>
              </td>
              <td>
                <UrlCell row={row} />
              </td>
              <td>
                {row.hubPath ? (
                  <span className="font-mono text-xs">{row.hubPath}</span>
                ) : (
                  <span className="text-base-content/40">&mdash;</span>
                )}
              </td>
              <td className="text-right tabular-nums">
                <span
                  className={
                    row.linksInjected === 0 ? "text-base-content/40" : ""
                  }
                >
                  {linksInjectedLabel(row.linksInjected)}
                </span>
              </td>
              <td>
                <ReceiptChip status={row.receiptStatus} />
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
