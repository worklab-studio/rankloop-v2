import { CardShell } from "@/client/features/dashboard/cardParts";
import {
  cadenceMonthLabel,
  formatFeaturePct,
  pageTypeDisplay,
} from "@/client/features/rankloop-plan/competitorDisplay.logic";
import { TagChip } from "@/client/features/saved-keywords/TagChip";
import type { getRankloopCompetitor } from "@/serverFunctions/rankloopCompetitors";

type Playbook = NonNullable<
  Awaited<ReturnType<typeof getRankloopCompetitor>>
>["playbook"];

// Div-based cadence bar, the same idiom as the Content inventory card: 24
// columns is too small a chart to justify recharts. Gutters drop to gap-0.5
// here — at gap-1 the bars would be thinner than the space between them. The
// busiest month gets the full primary fill so the eye finds the peak without
// an axis; empty months keep a 2px baseline so a publishing gap reads as a
// gap, not a missing bar.
function CadenceStrip({
  cadence,
}: {
  cadence: NonNullable<Playbook>["cadence"];
}) {
  const maxCount = cadence.reduce(
    (max, bucket) => Math.max(max, bucket.count),
    0,
  );
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/60">
        Posts per month
      </p>
      <div className="mt-2 flex h-8 items-end gap-0.5">
        {cadence.map((bucket) => (
          <div
            key={bucket.month}
            className={`flex-1 rounded-sm ${
              maxCount > 0 && bucket.count === maxCount
                ? "bg-primary"
                : "bg-primary/20"
            }`}
            style={{
              height:
                bucket.count === 0 || maxCount === 0
                  ? "2px"
                  : // Non-zero months never render under 20% of h-8, so a
                    // single post stays distinguishable from none.
                    `${Math.max(Math.round((bucket.count / maxCount) * 100), 20)}%`,
            }}
            title={`${cadenceMonthLabel(bucket.month)} · ${bucket.count} post${
              bucket.count === 1 ? "" : "s"
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-base-content/45">
        last 24 months, from sitemap lastmod
      </p>
    </div>
  );
}

function PageTypeMix({ mix }: { mix: NonNullable<Playbook>["pageTypeMix"] }) {
  if (mix.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-xs uppercase tracking-wide text-base-content/60">
        Page-type mix
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {mix.map((entry) => {
          const display = pageTypeDisplay(entry.pageType);
          return (
            <TagChip
              key={entry.pageType}
              size="xs"
              tag={{
                id: entry.pageType,
                name: `${entry.count.toLocaleString("en-US")} ${display.label}${
                  entry.count === 1 || display.label === "other" ? "" : "s"
                }`,
                color: display.color,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// The differentiator: what their top earners carry that their median post
// doesn't. Read as "of their 30 best-earning pages, 73% have a data table;
// of a 15-page median sample, 20% do" — the gap is the template contract.
function FeatureDeltas({
  deltas,
}: {
  deltas: NonNullable<Playbook>["featureDeltas"];
}) {
  if (deltas.length === 0) {
    return (
      <p className="mt-4 text-sm text-base-content/60">
        No structural difference between their earners and their median post.
      </p>
    );
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Feature</th>
            <th className="text-right">Winners</th>
            <th className="text-right">Median</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((delta) => (
            <tr key={delta.feature}>
              <td>{delta.feature}</td>
              <td className="text-right tabular-nums font-medium">
                {formatFeaturePct(delta.winnersPct)}
              </td>
              <td className="text-right tabular-nums text-base-content/60">
                {formatFeaturePct(delta.medianPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RankloopCompetitorPlaybookCard({
  playbook,
  coverage,
}: {
  playbook: Playbook;
  coverage: string | null;
}) {
  if (!playbook) {
    return (
      <CardShell title="Blog playbook">
        <p className="text-sm text-base-content/60">
          Nothing studied yet &mdash; the playbook lands with the first study.
        </p>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="Blog playbook"
      stamp={`sitemap · ${playbook.totalContentPages.toLocaleString(
        "en-US",
      )} content pages · refreshes monthly`}
    >
      <CadenceStrip cadence={playbook.cadence} />
      <PageTypeMix mix={playbook.pageTypeMix} />
      {coverage === "full" ? (
        <FeatureDeltas deltas={playbook.featureDeltas} />
      ) : (
        <p className="mt-4 text-sm text-base-content/60">
          Studied from sitemap only &mdash; their pages block crawling, so there
          is no winners-vs-median breakdown.
        </p>
      )}
    </CardShell>
  );
}
