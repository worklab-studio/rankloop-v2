import type { Metadata } from "next";
import Link from "next/link";
import { articles, fmtInt, fmtUsd } from "@/lib/mock";
import { CardShell, PageHeader } from "@/components/ui";
import type { Article, ArticleStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Articles — rankloop" };

/** The pipeline reads top to bottom: writer → gate → human → live → morgue.
 * Stage order IS the product story, so keep it fixed. */
const STAGES: { status: ArticleStatus; label: string; dot: string; empty: string }[] = [
  { status: "writing", label: "Writing", dot: "bg-info", empty: "nothing being written" },
  { status: "gate", label: "Gate", dot: "bg-warning", empty: "gate is clear" },
  { status: "review", label: "Review", dot: "bg-primary", empty: "review queue empty" },
  { status: "published", label: "Published", dot: "bg-success", empty: "nothing live yet" },
  { status: "failed", label: "Failed", dot: "bg-error", empty: "no failures" },
];

function failingCount(a: Article): number {
  return a.lawReport.filter((l) => !l.ok).length;
}

function fmtPos(p: number | null): string {
  return p === null ? "new" : p.toFixed(1);
}

/** Per-stage signal cell: what matters about this article right now. */
function Signal({ article }: { article: Article }) {
  const failing = failingCount(article);

  if (article.status === "writing") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-info">
        <span className="loading loading-dots loading-xs" />
        writer running
      </span>
    );
  }

  if ((article.status === "gate" || article.status === "failed") && failing > 0) {
    return (
      <span className="text-xs font-medium text-error">
        {failing} law{failing === 1 ? "" : "s"} failing
      </span>
    );
  }

  if (article.status === "review") {
    return <span className="text-xs text-base-content/50">laws pass · awaiting human eyes</span>;
  }

  if (article.status === "published" && article.receipts) {
    return (
      <span className="whitespace-nowrap text-xs tabular-nums">
        <span className="font-medium text-success">
          pos {fmtPos(article.receipts.positionBefore)} → {fmtPos(article.receipts.positionAfter)}
        </span>
        <span className="text-base-content/50">
          {" "}
          · +{fmtInt(article.receipts.impressionsDelta)} impr · +
          {fmtInt(article.receipts.clicksDelta)} clicks
        </span>
      </span>
    );
  }

  return null;
}

function ArticleRow({ article }: { article: Article }) {
  return (
    <tr>
      <td className="max-w-[24rem]">
        <Link href={`/articles/${article.id}`} className="block min-w-0">
          <span className="block truncate text-sm font-medium hover:text-primary">
            {article.title}
          </span>
          <span className="block truncate font-mono text-[11px] text-base-content/60">
            {article.keyword}
          </span>
        </Link>
      </td>
      <td className="text-right tabular-nums">
        {article.wordCount > 0 ? fmtInt(article.wordCount) : "—"}
      </td>
      <td className="text-right tabular-nums">{article.attempts}</td>
      <td className="text-right tabular-nums">{fmtUsd(article.costUsd)}</td>
      <td>
        <Signal article={article} />
      </td>
      <td className="text-right">
        <Link href={`/articles/${article.id}`} className="btn btn-ghost btn-xs">
          Open
        </Link>
      </td>
    </tr>
  );
}

export default function ArticlesPage() {
  const published = articles.filter((a) => a.status === "published").length;
  const totalCost = articles.reduce((s, a) => s + a.costUsd, 0);

  return (
    <>
      <PageHeader
        title="Articles"
        subtitle={`${articles.length} in pipeline · ${published} published · ${fmtUsd(totalCost)} attributed spend`}
        actions={
          <Link href="/opportunities" className="btn btn-primary btn-sm">
            Pick next from opportunities
          </Link>
        }
      />

      <CardShell
        title="Pipeline"
        stamp="stages read top to bottom: writer → gate → human review → live · failed drafts keep their spend attributed"
      >
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Article</th>
                <th className="text-right">Words</th>
                <th className="text-right">Attempts</th>
                <th className="text-right">Cost</th>
                <th>Signal</th>
                <th />
              </tr>
            </thead>
            {STAGES.map((stage) => {
              const items = articles.filter((a) => a.status === stage.status);
              return (
                <tbody key={stage.status}>
                  <tr>
                    <td colSpan={6}>
                      <span className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${stage.dot}`} />
                        <span className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
                          {stage.label}
                        </span>
                        <span className="badge badge-ghost badge-sm tabular-nums">
                          {items.length}
                        </span>
                      </span>
                    </td>
                  </tr>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-xs text-base-content/40">
                        {stage.empty}
                      </td>
                    </tr>
                  ) : (
                    items.map((a) => <ArticleRow key={a.id} article={a} />)
                  )}
                </tbody>
              );
            })}
          </table>
        </div>
      </CardShell>
    </>
  );
}
