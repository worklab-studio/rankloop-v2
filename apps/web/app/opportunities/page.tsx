import { Info } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { proposals, site } from "@/lib/mock";
import Queue from "./queue";

/** The approval queue — the product's core loop. The engine proposes with
 * evidence; the human says yes. Server shell only; all interactivity lives
 * in the Queue client island. The layout provides the gap-5 column, so the
 * page is a fragment: header, quota line, then the queue sections. */
export default function OpportunitiesPage() {
  const awaiting = proposals.filter((p) => p.status === "proposed").length;

  return (
    <>
      <PageHeader
        title="Opportunities"
        subtitle="Every proposal shows its evidence. Nothing is written without a yes."
      />

      {/* quota: what the cadence expects from today's approvals */}
      <div role="alert" className="alert alert-info alert-soft border border-info/20">
        <Info className="h-4 w-4 shrink-0" />
        <span className="text-sm">
          <span className="font-semibold">
            {site.quotaOwedToday} post{site.quotaOwedToday === 1 ? "" : "s"} owed today
          </span>{" "}
          on the {site.postsPerDay}/day cadence — unserved days carry over, they never vanish.
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {site.poolSlotReserved ? (
            <span className="badge badge-warning badge-outline badge-sm whitespace-nowrap">
              1 slot reserved: fresh-question pool
            </span>
          ) : null}
          <span className="badge badge-ghost badge-sm whitespace-nowrap">
            {awaiting} awaiting review
          </span>
        </div>
      </div>

      <Queue proposals={proposals} />
    </>
  );
}
