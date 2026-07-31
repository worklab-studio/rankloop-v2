import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import {
  CardShell,
  EmptyCardBody,
  formatDay,
  moreDetailsClass,
  newLost,
  Stat,
} from "@/client/features/dashboard/cardParts";
import { getBacklinksOverview } from "@/serverFunctions/backlinks";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";

// Five-minute client staleness on top of the server's 6h R2 cache — the
// same number and query key the Backlinks page uses, so opening that page
// after this card costs zero extra fetches.
const AUTHORITY_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

// Off-site authority for the project domain, straight from the backlinks
// feature's overview endpoint. The Backlink pulse card tracks the stored
// snapshot's deltas over time; this card is the live DataForSEO picture,
// including domain rank.
export function AuthorityCard({
  projectId,
  domain,
}: {
  projectId: string;
  domain: string;
}) {
  const keyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
  });
  // null = still checking; the skeleton below covers that window.
  const keyConfigured = keyStatusQuery.isSuccess
    ? keyStatusQuery.data.configured
    : null;

  const overviewQuery = useQuery({
    queryKey: ["backlinksOverview", projectId, "domain", domain],
    queryFn: () =>
      getBacklinksOverview({
        data: { projectId, target: domain, scope: "domain" },
      }),
    enabled: keyConfigured === true,
    staleTime: AUTHORITY_QUERY_STALE_TIME_MS,
  });
  const overview = overviewQuery.data;

  // Missing key is a pitch, not an error — the card sells the benefit and
  // hands over the setup guide; the app-shell banner owns the nagging. An
  // unverifiable key check lands here too rather than error-coloring a card
  // that may work fine on retry.
  if (keyConfigured === false || keyStatusQuery.isError) {
    return (
      <CardShell title="Authority">
        <EmptyCardBody
          message="Add your DataForSEO API key to see who links to your domain and how much weight those links carry."
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
        overview
          ? `DataForSEO · snapshot ${formatDay(overview.fetchedAt)}`
          : undefined
      }
      action={
        <Link
          to="/p/$projectId/backlinks"
          params={{ projectId }}
          search={{ target: domain, scope: "domain" }}
          className={moreDetailsClass}
        >
          More details
        </Link>
      }
    >
      {keyConfigured === null || overviewQuery.isPending ? (
        <div className="grid grid-cols-2 gap-3" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      ) : overviewQuery.isError ? (
        <p className="text-sm text-base-content/60">
          Couldn&rsquo;t load backlink data. Try again shortly.
        </p>
      ) : overview ? (
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Backlinks"
            value={
              overview.summary.backlinks === null
                ? "—"
                : overview.summary.backlinks.toLocaleString()
            }
          />
          <Stat
            label="Ref. domains"
            value={
              overview.summary.referringDomains === null
                ? "—"
                : overview.summary.referringDomains.toLocaleString()
            }
          />
          <Stat
            label="Domain rank"
            value={
              overview.summary.rank === null
                ? "—"
                : overview.summary.rank.toLocaleString()
            }
          />
          <Stat
            label="New / lost 30d"
            value={`▲ ${newLost(overview.summary.newBacklinks)}`}
            tone={
              overview.summary.newBacklinks && overview.summary.newBacklinks > 0
                ? "success"
                : undefined
            }
            sub={
              <p
                className={`text-xs tabular-nums ${
                  overview.summary.lostBacklinks &&
                  overview.summary.lostBacklinks > 0
                    ? "text-error"
                    : ""
                }`}
              >
                ▼ {newLost(overview.summary.lostBacklinks)}
              </p>
            }
          />
        </div>
      ) : null}
    </CardShell>
  );
}
