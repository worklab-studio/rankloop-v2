import Link from "next/link";
import { ArrowRight, MoveRight } from "lucide-react";
import {
  articles, fmtInt, fmtUsd, proposals, receiptSeries, site, spend, traffic,
  trafficTotals,
} from "@/lib/mock";
import type { ArticleStatus, PositionPoint, SpendEntry } from "@/lib/types";
import {
  CardShell, EmptyState, EvidenceChips, PageHeader, ScoreBadge, Stat,
  StatCard, TypeBadge, moreDetailsClass,
} from "@/components/ui";
import { SpendBar, TrafficChart } from "@/components/charts";

/** last non-null position, optionally restricted to dates strictly before a cutoff —
 * receipts derive "before" from the last pre-publish point and "after" from the
 * latest point, so the numbers match what GSC actually recorded. */
function lastPosition(points: PositionPoint[], before?: string): number | null {
  let last: number | null = null;
  for (const p of points) {
    if (p.position !== null && (before === undefined || p.date < before)) last = p.position;
  }
  return last;
}

const PIPELINE_STAGES: { status: ArticleStatus; label: string; tone?: "success" | "error" }[] = [
  { status: "writing", label: "writing" },
  { status: "gate", label: "gate" },
  { status: "review", label: "review" },
  { status: "published", label: "published", tone: "success" },
  { status: "failed", label: "failed", tone: "error" },
];

const PROVIDER_LABEL: Record<SpendEntry["provider"], string> = {
  dataforseo: "DataForSEO",
  llm: "LLM writer",
  image: "Images",
};

function ChartLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-base-content/60">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        impressions
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-success" />
        clicks
      </span>
    </div>
  );
}

export default function OverviewPage() {
  const proposedCount = proposals.filter((p) => p.status === "proposed").length;
  const topProposals = [...proposals]
    .filter((p) => p.status === "proposed")
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const totalSpent = spend.reduce((s, e) => s + e.monthUsd, 0);
  const totalBudget = spend.reduce((s, e) => s + e.budgetUsd, 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${site.name} · ${site.domain} · trust dial: ${site.trustDial}`}
        actions={
          proposedCount > 0 ? (
            <Link href="/opportunities" className="btn btn-primary btn-sm">
              Review {proposedCount} proposals
            </Link>
          ) : undefined
        }
      />

      {/* 1 · headline stats */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Impressions · 28d"
          value={fmtInt(trafficTotals.impressions)}
          deltaPct={trafficTotals.impressionsDeltaPct}
        />
        <StatCard
          label="Clicks · 28d"
          value={fmtInt(trafficTotals.clicks)}
          deltaPct={trafficTotals.clicksDeltaPct}
        />
        <StatCard
          label="Avg position"
          value={`#${trafficTotals.avgPosition.toFixed(1)}`}
          sub="across all ranking queries"
        />
        <StatCard
          label="CTR"
          value={`${trafficTotals.ctrPct.toFixed(1)}%`}
          sub="clicks ÷ impressions"
        />
      </div>

      {/* 2 · traffic chart, full width */}
      <CardShell
        title="Search performance"
        action={<ChartLegend />}
        stamp="Search Console · last 28 days"
      >
        <TrafficChart data={traffic} />
      </CardShell>

      {/* 3 · receipts | pipeline | spend | latest proposals */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {receiptSeries.length > 0 ? (
          <CardShell
            title="Receipts"
            action={
              <Link href="/receipts" className={moreDetailsClass}>
                All receipts
                <ArrowRight className="h-3 w-3" />
              </Link>
            }
            stamp="Position on the target query, before → after publish · Search Console"
          >
            <div className="divide-y divide-base-300">
              {receiptSeries.map((s) => {
                const before = lastPosition(s.points, s.publishedAt);
                const after = lastPosition(s.points);
                const improved = after !== null && (before === null || after < before);
                return (
                  <div
                    key={s.articleId}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{s.articleTitle}</div>
                      <div className="truncate text-xs text-base-content/50">{s.targetQuery}</div>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-3">
                      <span className="text-sm font-semibold tabular-nums">
                        {before === null ? "new" : `#${before.toFixed(1)}`}
                        <MoveRight
                          className={`mx-1 inline h-3.5 w-3.5 ${improved ? "text-success" : "text-error"}`}
                        />
                        <span className={improved ? "text-success" : "text-error"}>
                          {after === null ? "—" : `#${after.toFixed(1)}`}
                        </span>
                      </span>
                      <span className="text-xs tabular-nums text-base-content/60">
                        +{fmtInt(s.impressionsDelta)} impr
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardShell>
        ) : (
          <EmptyState
            title="No receipts yet"
            hint="Published articles report back here once Search Console shows movement."
          />
        )}

        <CardShell
          title="Pipeline"
          action={
            <div className="flex items-center gap-2">
              {site.quotaOwedToday > 0 ? (
                <span className="badge badge-warning badge-sm">
                  {site.quotaOwedToday} owed today
                </span>
              ) : (
                <span className="badge badge-ghost badge-sm">quota clear</span>
              )}
              <Link href="/articles" className={moreDetailsClass}>
                All articles
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          }
          stamp={`Cadence ${site.postsPerDay}/day with catch-up · pool slot ${
            site.poolSlotReserved ? "reserved for a harvested question" : "not reserved"
          }`}
        >
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-5">
            {PIPELINE_STAGES.map(({ status, label, tone }) => {
              const count = articles.filter((a) => a.status === status).length;
              return (
                <Stat
                  key={status}
                  label={label}
                  value={String(count)}
                  tone={count > 0 ? tone : undefined}
                />
              );
            })}
          </div>
        </CardShell>

        <CardShell
          title="Spend"
          action={
            <span className="text-xs tabular-nums text-base-content/60">
              {fmtUsd(totalSpent)} / {fmtUsd(totalBudget)}
            </span>
          }
          stamp="Month to date, from the spend ledger — discovery pauses at the cap, publishing never blocks"
        >
          <div className="space-y-4">
            {spend.map((e) => (
              <SpendBar
                key={e.provider}
                label={PROVIDER_LABEL[e.provider]}
                spent={e.monthUsd}
                budget={e.budgetUsd}
              />
            ))}
          </div>
        </CardShell>

        {topProposals.length > 0 ? (
          <CardShell
            title="Latest proposals"
            action={
              <Link href="/opportunities" className={moreDetailsClass}>
                View all
                <ArrowRight className="h-3 w-3" />
              </Link>
            }
            stamp="Highest-scoring open proposals — every score shows its factors"
          >
            <div className="divide-y divide-base-300">
              {topProposals.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <TypeBadge type={p.type} />
                      <span className="truncate text-sm font-medium">{p.title}</span>
                    </div>
                    <div className="truncate text-xs text-base-content/50">{p.target}</div>
                    <EvidenceChips evidence={p.evidence} />
                  </div>
                  <div className="shrink-0 text-right">
                    <ScoreBadge score={p.score} />
                    <div className="text-[11px] text-base-content/40">score</div>
                  </div>
                </div>
              ))}
            </div>
          </CardShell>
        ) : (
          <EmptyState
            title="No open proposals"
            hint="The next discovery run will surface new opportunities here."
          />
        )}
      </div>
    </>
  );
}
