import { useQuery } from "@tanstack/react-query";
import { AuthorityCard } from "@/client/features/dashboard/AuthorityCard";
import { ContentInventoryCard } from "@/client/features/dashboard/ContentInventoryCard";
import { AuditHealthCard } from "@/client/features/dashboard/DashboardCards";
import { IndexationCard } from "@/client/features/dashboard/IndexationCard";
import {
  getDashboardActivation,
  getDashboardOverview,
} from "@/serverFunctions/dashboard";
import { getRankloopSiteStudy } from "@/serverFunctions/rankloopSiteStudy";

// The four things worth knowing about your own site, in one place (spec
// 0028): how far it reaches, how much of it is indexed, what shape the
// pages are in, and how much there is.
//
// These cards were scattered across the dashboard, where Reach appeared
// twice under two names. Here each metric has exactly one home, which is
// what stops a number showing up in two places with two values.
export function RankloopSiteHealth({ projectId }: { projectId: string }) {
  // Same query key the dashboard uses, so the domain here and the domain
  // there can never disagree and one fetch serves both.
  const activationQuery = useQuery({
    queryKey: ["dashboardActivation", projectId],
    queryFn: () => getDashboardActivation({ data: { projectId } }),
  });
  const overviewQuery = useQuery({
    queryKey: ["dashboardOverview", projectId],
    queryFn: () => getDashboardOverview({ data: { projectId } }),
  });
  const studyQuery = useQuery({
    queryKey: ["rankloopSiteStudy", projectId],
    queryFn: () => getRankloopSiteStudy({ data: { projectId } }),
  });

  const domain = activationQuery.data?.domain ?? "";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {domain ? <AuthorityCard projectId={projectId} domain={domain} /> : null}
      <IndexationCard projectId={projectId} />
      <AuditHealthCard
        projectId={projectId}
        audit={overviewQuery.data?.audit ?? null}
      />
      <ContentInventoryCard projectId={projectId} study={studyQuery.data} />
    </div>
  );
}
