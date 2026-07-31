import { Markdown } from "@/client/components/Markdown";
import { Collapsible } from "@/client/features/ai-mcp/SetupControls";
import {
  articleStampLine,
  failedLaws,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
import type { getRankloopArticle } from "@/serverFunctions/rankloopWriter";

type ArticleDetail = NonNullable<
  Awaited<ReturnType<typeof getRankloopArticle>>
>;
type LawEntry = NonNullable<ArticleDetail["lawReport"]>[number];

/** Severity as a bare dot, the audit/dashboard idiom — a pass is not worth a
 *  badge, and a failure is worth reading the line next to it. */
export function StatusDot({ passed }: { passed: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-1.5 size-2 shrink-0 rounded-full ${
        passed ? "bg-success" : "bg-error"
      }`}
    />
  );
}

function LawRow({ entry }: { entry: LawEntry }) {
  return (
    <li className="flex items-start gap-2.5">
      <StatusDot passed={entry.passed} />
      <div className="min-w-0 flex-1">
        <p
          className={
            entry.passed
              ? "text-sm text-base-content/70"
              : "text-sm font-medium"
          }
        >
          {entry.law}
        </p>
        {/* The offending text, quoted rather than described. A banned phrase
            or an unresolvable slug is a string you can search the draft for,
            and handing it over is what makes fixing it a 10-second job. */}
        {entry.excerpt ? (
          <p className="mt-1 break-words border-l-2 border-error/40 bg-error/5 py-1 pl-2 font-mono text-xs text-base-content/70">
            {entry.excerpt}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The law report, the brief and the bill — everything that explains the draft
 * on the left.
 *
 * Passes are listed beside failures because the report is the product's
 * receipt for quality: "9 of 12" is a grade, "3 problems" is a complaint.
 * Each law names its own threshold (`word count >= 850`, `title <= 70
 * chars`) because that string is what the engine's law table is keyed by —
 * the number shown is literally the number checked, not a copy of it that
 * could drift.
 */
export function RankloopArticleReport({ article }: { article: ArticleDetail }) {
  const report = article.lawReport ?? [];
  const failed = failedLaws(report).length;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <h2 className="text-base font-semibold leading-tight">Law report</h2>
          {report.length > 0 ? (
            <span className="text-xs tabular-nums text-base-content/60">
              {report.length - failed} of {report.length} passed
            </span>
          ) : null}
        </div>

        {report.length === 0 ? (
          <p className="border-t border-base-300 p-4 text-sm text-base-content/60">
            The gate hasn&rsquo;t run yet. Every law lands here the moment the
            draft is checked, passes included.
          </p>
        ) : (
          <ul className="space-y-2.5 border-t border-base-300 p-4">
            {report.map((entry) => (
              <LawRow key={entry.law} entry={entry} />
            ))}
          </ul>
        )}

        <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
          {articleStampLine(article)}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        <Collapsible
          id="rankloop-article-brief"
          title="Brief"
          subtitle="Frozen when writing started — the laws are read against this"
        >
          {article.briefMd ? (
            <Markdown className="prose prose-sm text-sm">
              {article.briefMd}
            </Markdown>
          ) : (
            <p className="text-sm text-base-content/60">
              No brief stored for this article.
            </p>
          )}
        </Collapsible>
      </div>
    </div>
  );
}
