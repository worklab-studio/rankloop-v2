import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RankloopAiAccessPanel } from "@/client/features/rankloop-verdict/RankloopAiAccessPanel";
import { RankloopCompetitorsTab } from "@/client/features/rankloop-plan/RankloopCompetitorsTab";
import { RankloopSiteHealth } from "@/client/features/rankloop-verdict/RankloopSiteHealth";

export const Route = createFileRoute("/_project/p/$projectId/study")({
  component: StudyPage,
});

type StudyTab = "site" | "market";

// What rankloop found, before it proposes anything (spec 0028). Read-only
// and refreshed on its own — nothing here asks the user for a decision,
// which is what separates it from Plan.
function StudyPage() {
  const { projectId } = Route.useParams();
  const [tab, setTab] = useState<StudyTab>("site");

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Study</h1>
          <p className="text-sm text-base-content/70">
            What rankloop has learned about your site and the people you
            compete with.
          </p>
        </div>

        <div role="tablist" className="tabs tabs-border w-fit">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "site"}
            className={`tab ${tab === "site" ? "tab-active" : ""}`}
            onClick={() => setTab("site")}
          >
            Your site
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "market"}
            className={`tab ${tab === "market" ? "tab-active" : ""}`}
            onClick={() => setTab("market")}
          >
            Your market
          </button>
        </div>

        {tab === "site" ? (
          <div className="space-y-6">
            <RankloopSiteHealth projectId={projectId} />
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-base-content/60">
                AI access
              </h2>
              <RankloopAiAccessPanel projectId={projectId} />
            </div>
          </div>
        ) : (
          <RankloopCompetitorsTab projectId={projectId} />
        )}
      </div>
    </div>
  );
}
