import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { articles, fmtInt, fmtUsd, receiptSeries } from "@/lib/mock";
import { CardShell, PageHeader, StatusDot, TagChip } from "@/components/ui";
import { PositionChart } from "@/components/charts";
import type { ArticleStatus } from "@/lib/types";
import { ArticleActions } from "./article-actions";

/** Status stays a quiet ghost badge; the colored dot carries the stage. */
const STATUS_DOT: Record<ArticleStatus, string> = {
  writing: "bg-info",
  gate: "bg-warning",
  review: "bg-primary",
  published: "bg-success",
  failed: "bg-error",
};

export function generateStaticParams() {
  return articles.map((a) => ({ id: a.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const article = articles.find((a) => a.id === id);
  return { title: article ? `${article.title} — rankloop` : "Article — rankloop" };
}

function fmtPos(p: number | null): string {
  return p === null ? "new" : p.toFixed(1);
}

export default async function ArticleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const article = articles.find((a) => a.id === id);
  if (!article) notFound();

  const series = receiptSeries.find((s) => s.articleId === article.id) ?? null;
  const failing = article.lawReport.filter((l) => !l.ok);
  const allPass = article.lawReport.length > 0 && failing.length === 0;

  const meta: { label: string; value: ReactNode }[] = [
    { label: "slug", value: <span className="font-mono text-xs">/{article.slug}/</span> },
    { label: "category", value: <TagChip color="slate">{article.category}</TagChip> },
    { label: "keyword", value: <span className="font-mono text-xs">{article.keyword}</span> },
    {
      label: "word count",
      value: (
        <span className="tabular-nums">
          {article.wordCount > 0 ? fmtInt(article.wordCount) : "—"}
        </span>
      ),
    },
    { label: "attempts", value: <span className="tabular-nums">{article.attempts}</span> },
    { label: "cost", value: <span className="tabular-nums">{fmtUsd(article.costUsd)}</span> },
  ];
  if (article.publishedAt) {
    meta.push({
      label: "published",
      value: <span className="tabular-nums">{article.publishedAt}</span>,
    });
  }

  return (
    <>
      <div>
        <Link
          href="/articles"
          className="btn btn-ghost btn-xs mb-2 gap-1 px-1 text-base-content/60"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          all articles
        </Link>
        <PageHeader
          title={article.title}
          subtitle={`${article.keyword} · ${article.category}`}
          actions={
            <>
              <span className="badge badge-ghost badge-sm gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[article.status]}`}
                />
                {article.status}
              </span>
              {article.publishedUrl ? (
                <a
                  href={article.publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm gap-1.5"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View live
                </a>
              ) : null}
            </>
          }
        />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {/* left: the draft */}
        <CardShell
          title="Draft"
          stamp={
            article.excerpt
              ? `excerpt — first paragraphs of the ${
                  article.wordCount > 0 ? `${fmtInt(article.wordCount)}-word ` : ""
                }draft`
              : undefined
          }
        >
          <p className="text-sm text-base-content/70">{article.description}</p>

          {article.excerpt ? (
            <p className="mt-4 text-[15px] leading-7 text-base-content/80">{article.excerpt}</p>
          ) : (
            <p className="mt-4 text-sm italic text-base-content/40">
              no draft yet — the writer is still working this brief.
            </p>
          )}

          <div className="mt-5 overflow-x-auto">
            <table className="table table-sm">
              <tbody>
                {meta.map((m) => (
                  <tr key={m.label}>
                    <td className="text-xs uppercase tracking-wide text-base-content/50">
                      {m.label}
                    </td>
                    <td className="text-right">{m.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardShell>

        {/* right: laws, receipts, actions */}
        <div className="flex flex-col gap-5">
          <CardShell title="Laws report">
            {article.lawReport.length === 0 ? (
              <p className="text-xs text-base-content/50">
                gate has not run yet — laws check the first complete draft.
              </p>
            ) : (
              <div className="space-y-3">
                {allPass ? (
                  <div className="alert alert-success px-3 py-2 text-sm">all laws pass</div>
                ) : (
                  <p className="text-xs font-medium text-error">
                    {failing.length} of {article.lawReport.length} laws failing
                  </p>
                )}
                <ul className="space-y-2">
                  {article.lawReport.map((l) => (
                    <li key={l.law} className="flex items-start gap-2 text-xs">
                      <span className="mt-1">
                        <StatusDot ok={l.ok} />
                      </span>
                      <span className="min-w-0">
                        <span className={l.ok ? "text-base-content/80" : "font-medium text-error"}>
                          {l.law}
                        </span>
                        {l.detail ? (
                          <span className={`block ${l.ok ? "text-base-content/50" : "text-error/80"}`}>
                            {l.detail}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardShell>

          <CardShell
            title="Receipts"
            action={
              article.status === "published" ? (
                <Link href="/receipts" className="btn btn-ghost btn-xs">
                  All receipts
                </Link>
              ) : undefined
            }
            stamp={
              article.receipts ? `target query "${article.receipts.targetQuery}"` : undefined
            }
          >
            {article.status === "published" ? (
              <>
                {series ? (
                  <PositionChart points={series.points} publishedAt={series.publishedAt} />
                ) : null}
                {article.receipts ? (
                  <div className={`flex flex-wrap gap-x-4 gap-y-1 text-xs ${series ? "mt-3" : ""}`}>
                    <span className="font-medium tabular-nums text-success">
                      pos {fmtPos(article.receipts.positionBefore)} →{" "}
                      {fmtPos(article.receipts.positionAfter)}
                    </span>
                    <span className="tabular-nums text-base-content/60">
                      +{fmtInt(article.receipts.impressionsDelta)} impressions
                    </span>
                    <span className="tabular-nums text-base-content/60">
                      +{fmtInt(article.receipts.clicksDelta)} clicks
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-base-content/50">
                    receipts pending — first GSC sync lands about 3 days after publish.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-base-content/50">
                appear after publish — every article reports back what it moved.
              </p>
            )}
          </CardShell>

          <ArticleActions status={article.status} attempts={article.attempts} />
        </div>
      </div>
    </>
  );
}
