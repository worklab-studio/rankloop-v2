import type { Metadata } from "next";
import { competitors, gapKeywords, fmtInt } from "@/lib/mock";
import { CardShell, EmptyState, PageHeader } from "@/components/ui";
import { TrackToggle } from "./track-toggle";
import { GapTable } from "./gap-table";

export const metadata: Metadata = { title: "Competitors — rankloop" };

export default function CompetitorsPage() {
  // biggest demand first; NULL-volume rows sink to the bottom, never vanish
  const gaps = [...gapKeywords].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  return (
    <>
      <PageHeader
        title="Competitors"
        subtitle="Keyword overlap from the SERP index — who already owns the queries you want. Refreshed weekly."
      />

      {competitors.length === 0 ? (
        <EmptyState
          title="No competitors discovered yet"
          hint="Overlap analysis runs after the first keyword sync — check back once discovery has spent its first budget."
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {competitors.map((c) => (
            <div
              key={c.domain}
              className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={c.domain}>
                    {c.domain}
                  </p>
                  <p className="text-xs text-base-content/50">
                    {fmtInt(c.keywordCount)} ranking keywords
                  </p>
                </div>
                <TrackToggle domain={c.domain} initialTracked={c.tracked} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-base-content/60">
                    Shared kw
                  </p>
                  <p className="text-xl font-semibold tabular-nums">
                    {fmtInt(c.intersections)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-base-content/60">
                    Avg pos
                  </p>
                  <p className="text-xl font-semibold tabular-nums">
                    #{c.avgPosition.toFixed(1)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CardShell
        title="Keyword gap"
        action={<span className="badge badge-ghost badge-sm">{gaps.length}</span>}
        stamp="Tracked competitors feed this table and the gap factor in opportunity scores. Untracked domains stay visible but never influence proposals."
      >
        <p className="text-sm text-base-content/60">
          Queries competitors rank top-10 for, inside your difficulty ceiling (KD ≤ 32), where
          you are absent.
        </p>
        {gaps.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No gap keywords right now"
              hint="Either you cover everything your tracked competitors rank for, or no competitor is tracked yet."
            />
          </div>
        ) : (
          <div className="mt-3">
            <GapTable rows={gaps} />
          </div>
        )}
      </CardShell>
    </>
  );
}
