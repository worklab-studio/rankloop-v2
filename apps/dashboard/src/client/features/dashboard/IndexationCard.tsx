import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CardShell,
  moreDetailsClass,
  Stat,
} from "@/client/features/dashboard/cardParts";
import {
  indexationRateLabel,
  indexationStamp,
  indexationThrottleChip,
  indexationUnknownCopy,
} from "@/client/features/rankloop-articles/indexationDisplay.logic";
import { TagChip } from "@/client/features/saved-keywords/TagChip";
import { getRankloopIndexation } from "@/serverFunctions/rankloopIndexation";

// Whether Google is actually keeping what rankloop publishes — the number that
// decides how fast the engine is allowed to run (spec 0022).
//
// It is the only card whose data governs another screen: below 65% the daily
// quota is capped and below 40% net-new proposing stops, so the chip here and
// the line on the Articles header are two views of one decision, and both read
// their state from the server rather than recomputing the thresholds.

export function IndexationCard({ projectId }: { projectId: string }) {
  const indexationQuery = useQuery({
    queryKey: ["rankloopIndexation", projectId],
    queryFn: () => getRankloopIndexation({ data: { projectId } }),
  });

  if (indexationQuery.isPending) {
    return (
      <CardShell title="Indexation">
        <div aria-busy className="space-y-3">
          <div className="skeleton h-3 w-16" />
          <div className="skeleton h-8 w-20" />
        </div>
      </CardShell>
    );
  }

  if (indexationQuery.isError) {
    return (
      <CardShell title="Indexation">
        <p className="text-sm text-base-content/60">
          Couldn&rsquo;t read the indexation checks. Try again shortly.
        </p>
      </CardShell>
    );
  }

  const summary = indexationQuery.data;
  const chip = indexationThrottleChip(summary.throttle);

  return (
    <CardShell
      title="Indexation"
      // Only stamp what was actually measured: a project with nothing in the
      // cohort would otherwise get a provenance line for zero posts.
      stamp={
        summary.cohort > 0
          ? indexationStamp(summary)
          : "URL Inspection · Google Search Console"
      }
      action={
        <Link
          to="/p/$projectId/articles"
          params={{ projectId }}
          className={moreDetailsClass}
        >
          More details
        </Link>
      }
    >
      <div className="flex items-start justify-between gap-4">
        {/* The Stat stays neutral at every rate. The chip is the only thing on
            this card that earns a colour, because the throttle is the only
            thing here anyone has to act on. */}
        <Stat label="Indexed" value={indexationRateLabel(summary.rate)} />
        {chip ? (
          <TagChip
            size="sm"
            tag={{ id: "throttle", name: chip.label, color: chip.color }}
          />
        ) : null}
      </div>

      {summary.rate === null ? (
        <p className="mt-2 text-sm text-base-content/60">
          {indexationUnknownCopy({
            connected: summary.connected,
            minimumCohort: summary.minimumCohort,
          })}
        </p>
      ) : null}
    </CardShell>
  );
}
