import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  CardShell,
  EmptyCardBody,
  formatDay,
  Stat,
} from "@/client/features/dashboard/cardParts";
import {
  formatCount,
  formatTraffic,
  pageStatusDisplay,
  pageTypeDisplay,
  urlPath,
} from "@/client/features/rankloop-plan/competitorDisplay.logic";
import { RankloopCompetitorPlaybookCard } from "@/client/features/rankloop-plan/RankloopCompetitorPlaybookCard";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import type { getRankloopCompetitor } from "@/serverFunctions/rankloopCompetitors";
import { tagChipClass } from "@/shared/tag-colors";

type CompetitorDetail = NonNullable<
  Awaited<ReturnType<typeof getRankloopCompetitor>>
>;
type CompetitorPage = CompetitorDetail["topPages"][number];

// Chip anatomy mirrors TagChip's xs size so page types and page statuses read
// as the same system as the tracked table's coverage chips.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

function PagePathLink({ page }: { page: CompetitorPage }) {
  return (
    <SafeExternalLink
      url={page.url}
      label={urlPath(page.url)}
      className="link link-hover break-all inline-flex max-w-sm items-center gap-1 font-mono text-xs"
    />
  );
}

function AuthorityCard({
  competitor,
  keyless,
}: {
  competitor: CompetitorDetail["competitor"];
  keyless: boolean;
}) {
  // Missing key is a pitch, not an error: the sitemap half of a study runs
  // fine without one, so this card sells what the key would add rather than
  // pretending the competitor is broken.
  if (keyless) {
    return (
      <CardShell title="Authority">
        <EmptyCardBody
          message="Add your DataForSEO API key to see how much weight this competitor carries — domain rank, keyword count, and estimated traffic."
          cta={
            <Link
              {...dataforseoHelpLinkOptions}
              className="link link-primary text-sm font-medium"
            >
              Open setup guide →
            </Link>
          }
        />
      </CardShell>
    );
  }

  return (
    <CardShell
      title="Authority"
      stamp={
        competitor.lastStudiedAt
          ? `DataForSEO · ${formatDay(competitor.lastStudiedAt)}`
          : undefined
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Domain rank" value={formatCount(competitor.domainRank)} />
        <Stat
          label="Organic keywords"
          value={formatCount(competitor.organicKeywords)}
        />
        <Stat
          label="Est. traffic"
          value={formatTraffic(competitor.estTraffic)}
        />
      </div>
    </CardShell>
  );
}

function TopEarningPagesCard({
  pages,
  keyless,
}: {
  pages: CompetitorPage[];
  keyless: boolean;
}) {
  return (
    <CardShell
      title="Top earning pages"
      stamp="DataForSEO Labs · top 100 by traffic value"
    >
      {pages.length === 0 ? (
        <p className="text-sm text-base-content/60">
          {keyless
            ? "Page-level earnings need a DataForSEO API key. The sitemap study below runs without one."
            : "No earning pages yet — they arrive with the first study."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Path</th>
                <th className="text-right">Est. traffic</th>
                <th className="text-right">Keywords</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => {
                const type = pageTypeDisplay(page.pageType);
                return (
                  <tr key={page.id}>
                    <td>
                      <PagePathLink page={page} />
                      {page.title ? (
                        <span
                          className="block max-w-sm truncate text-base-content/50"
                          title={page.title}
                        >
                          {page.title}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatTraffic(page.etv)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatCount(page.keywordCount)}
                    </td>
                    <td>
                      <span
                        className={`${chipBaseClass} ${tagChipClass(type.color)}`}
                      >
                        {type.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

// The what-not-to-build panel: pages a competitor let rot or deleted are
// negative evidence, and the first run can't produce any — there is no prior
// snapshot to diff against.
function DecayedPagesCard({ pages }: { pages: CompetitorPage[] }) {
  return (
    <CardShell title="Decayed & removed">
      {pages.length === 0 ? (
        <p className="text-sm text-base-content/60">
          Appears after the first monthly refresh.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Path</th>
                <th>Status</th>
                <th className="text-right">Est. traffic</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => {
                const status = pageStatusDisplay(page.status);
                return (
                  <tr key={page.id}>
                    <td>
                      <PagePathLink page={page} />
                    </td>
                    <td>
                      <span
                        className={`${chipBaseClass} ${tagChipClass(status.color)}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {formatTraffic(page.etv)}
                    </td>
                    <td className="text-base-content/70">
                      {formatDay(page.lastSeenAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

function headerStamp(competitor: CompetitorDetail["competitor"]): string {
  if (
    competitor.studyStatus === "pending" ||
    competitor.studyStatus === "running"
  ) {
    return "Studying now · refreshes monthly";
  }
  if (competitor.lastStudiedAt === null) return "Not studied yet";
  return `Studied ${formatDay(competitor.lastStudiedAt)} · refreshes monthly`;
}

export function RankloopCompetitorDetail({
  projectId,
  detail,
}: {
  projectId: string;
  detail: CompetitorDetail;
}) {
  const keyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
  });
  const keyless =
    keyStatusQuery.isError ||
    (keyStatusQuery.isSuccess && !keyStatusQuery.data.configured);

  const { competitor, playbook, topPages, decayedPages } = detail;

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/p/$projectId/plan"
          params={{ projectId }}
          className="btn btn-ghost btn-sm gap-2 px-0 text-base-content/70 hover:bg-transparent"
        >
          <ArrowLeft className="size-4" />
          Competitors
        </Link>
        <h2 className="text-lg font-semibold">{competitor.domain}</h2>
        <p className="text-xs text-base-content/60">
          {headerStamp(competitor)}
        </p>
      </div>

      <AuthorityCard competitor={competitor} keyless={keyless} />
      <TopEarningPagesCard pages={topPages} keyless={keyless} />
      <RankloopCompetitorPlaybookCard
        playbook={playbook}
        coverage={competitor.coverage}
      />
      <DecayedPagesCard pages={decayedPages} />
    </div>
  );
}
