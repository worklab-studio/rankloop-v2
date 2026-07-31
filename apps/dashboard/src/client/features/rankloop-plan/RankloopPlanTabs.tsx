import { useState } from "react";
import { RankloopCompetitorsTab } from "@/client/features/rankloop-plan/RankloopCompetitorsTab";
import { RankloopKeywordsTab } from "@/client/features/rankloop-plan/RankloopKeywordsTab";
import { RankloopOutreachTab } from "@/client/features/rankloop-plan/RankloopOutreachTab";
import { RankloopPageTypesTab } from "@/client/features/rankloop-plan/RankloopPageTypesTab";
import { useCompetitorsPolling } from "@/client/features/rankloop-plan/useCompetitorsPolling";
import { usePagePlanPolling } from "@/client/features/rankloop-plan/usePagePlanPolling";

type PlanTab = "competitors" | "keywords" | "pageTypes" | "outreach";

function PlanTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab ${active ? "tab-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function RankloopPlanTabs({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<PlanTab>("competitors");

  // Same query key the Competitors tab reads, so the count in the tab label
  // and the rows under it can never disagree — and switching tabs costs no
  // extra fetch.
  const competitorsQuery = useCompetitorsPolling(projectId);
  const trackedCount = competitorsQuery.data?.tracked.length;

  // Same story for the page plan: the count in the label and the cards under
  // it come from one query, so a recompute can never leave the strip claiming
  // a stale number.
  const planQuery = usePagePlanPolling(projectId);
  const proposedCount = planQuery.data?.proposed.length;

  return (
    <div className="space-y-4">
      <div role="tablist" className="tabs tabs-border w-fit">
        <PlanTabButton
          active={tab === "competitors"}
          onClick={() => setTab("competitors")}
          label={
            trackedCount === undefined
              ? "Competitors"
              : `Competitors (${trackedCount} tracked)`
          }
        />
        <PlanTabButton
          active={tab === "keywords"}
          onClick={() => setTab("keywords")}
          label="Keywords"
        />
        <PlanTabButton
          active={tab === "pageTypes"}
          onClick={() => setTab("pageTypes")}
          label={
            proposedCount === undefined
              ? "Page types"
              : `Page types (${proposedCount} proposed)`
          }
        />
        <PlanTabButton
          active={tab === "outreach"}
          onClick={() => setTab("outreach")}
          label="Outreach"
        />
      </div>

      {tab === "keywords" ? (
        <RankloopKeywordsTab projectId={projectId} />
      ) : tab === "pageTypes" ? (
        <RankloopPageTypesTab projectId={projectId} />
      ) : tab === "outreach" ? (
        <RankloopOutreachTab projectId={projectId} />
      ) : (
        <RankloopCompetitorsTab projectId={projectId} />
      )}
    </div>
  );
}
