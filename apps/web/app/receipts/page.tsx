import Link from "next/link";
import { PositionChart } from "@/components/charts";
import { CardShell, EmptyState, PageHeader, Stat, TagChip } from "@/components/ui";
import { articles, fmtInt, receiptSeries } from "@/lib/mock";
import type { ReceiptSeries } from "@/lib/types";

/** Receipts — the accountability screen. Every number here is differenced
 * against the site trend so a rising tide never gets claimed as a win. */

function fmtPos(p: number | null): string {
  return p === null ? "—" : `#${p.toFixed(1)}`;
}

function fmtDelta(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtInt(n)}`;
}

/** Before/after come from the article's receipts (the canonical numbers);
 * fall back to the series endpoints if the article row is missing. */
function positions(s: ReceiptSeries): { before: number | null; after: number | null } {
  const r = articles.find((a) => a.id === s.articleId)?.receipts;
  if (r) return { before: r.positionBefore, after: r.positionAfter };
  const seen = s.points.filter((p) => p.position !== null);
  return {
    before: seen[0]?.position ?? null,
    after: seen[seen.length - 1]?.position ?? null,
  };
}

/** Days since publish, measured to the last data point in the series. */
function evalDay(s: ReceiptSeries): number | null {
  const last = s.points[s.points.length - 1];
  if (!last) return null;
  return Math.round((Date.parse(last.date) - Date.parse(s.publishedAt)) / 86_400_000);
}

function ReceiptCard({ series }: { series: ReceiptSeries }) {
  const { before, after } = positions(series);
  const day = evalDay(series);
  const improved = after !== null && (before === null || after < before);

  return (
    <CardShell
      title={series.articleTitle}
      action={
        <div className="flex items-center gap-2">
          {day !== null ? (
            <TagChip color="sky">day {day} of the 42-day window</TagChip>
          ) : null}
          <Link href={`/articles/${series.articleId}`} className="btn btn-ghost btn-xs">
            View article
          </Link>
        </div>
      }
      stamp={`target query "${series.targetQuery}" · published ${series.publishedAt}`}
    >
      <div className="grid gap-5 lg:grid-cols-3">
        <Stat
          label="position"
          value={`${fmtPos(before)} → ${fmtPos(after)}`}
          tone={improved ? "success" : undefined}
          sub={
            <p className="text-xs text-base-content/60">
              {before === null
                ? "entered the index after publish"
                : after !== null
                  ? `up ${(before - after).toFixed(1)} spots`
                  : "still measuring"}
            </p>
          }
        />
        <Stat
          label="impressions"
          value={fmtDelta(series.impressionsDelta)}
          sub={<p className="text-xs text-base-content/60">vs 28d baseline, trend-adjusted</p>}
        />
        <Stat
          label="clicks"
          value={fmtDelta(series.clicksDelta)}
          sub={<p className="text-xs text-base-content/60">vs 28d baseline, trend-adjusted</p>}
        />
      </div>

      {/* the receipts visual — position over time, publish marked */}
      <div className="mt-5">
        <PositionChart points={series.points} publishedAt={series.publishedAt} />
      </div>
    </CardShell>
  );
}

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        subtitle="Every published article reports what it moved. Baselines 28d before, evaluation window days 14–42 after, differenced against site trend."
      />

      {receiptSeries.length === 0 ? (
        <EmptyState
          title="No receipts yet"
          hint="Receipts appear automatically 14 days after an article is published."
        />
      ) : (
        receiptSeries.map((s) => <ReceiptCard key={s.articleId} series={s} />)
      )}

      {/* the fine print that makes the numbers trustworthy */}
      <CardShell title="Attribution honesty">
        <p className="text-xs leading-relaxed text-base-content/60">
          A receipt is marked <span className="font-medium text-base-content/80">contaminated</span>{" "}
          when another action — a retitle, a refresh, an internal-links push — touched the same page
          inside its evaluation window. The movement can no longer be attributed to the article
          alone, so the receipt is excluded from cohort math rather than quietly counted as a win.
          Deltas are diff-in-diff: differenced against the site trend, so a rising tide is never
          claimed as a win. Autopilot promotion never rides on a single good receipt: the trust dial
          only advances on the 90-day cohort, where enough clean receipts exist to separate the
          engine&apos;s work from luck.
        </p>
      </CardShell>

      <EmptyState
        title="2 of 3 published articles measured · 1 inside its evaluation window"
        hint="Articles younger than 14 days have no receipt yet — the window opens on day 14 and closes on day 42."
      />
    </>
  );
}
