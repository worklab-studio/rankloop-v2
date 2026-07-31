import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  indexationVerdictLine,
  isIndexationFailure,
} from "@/client/features/rankloop-articles/indexationDisplay.logic";
import {
  publishedPath,
  publishLinkCaveat,
  publishPlanSentence,
} from "@/client/features/rankloop-articles/publishPlan.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import {
  getRankloopPublishPlan,
  publishRankloopArticle,
} from "@/serverFunctions/rankloopPublishArticle";

type PublishPlan = Awaited<ReturnType<typeof getRankloopPublishPlan>>;

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <h2 className="text-base font-semibold leading-tight">Publish</h2>
      </div>
      <div className="border-t border-base-300 p-4">{children}</div>
    </div>
  );
}

// Mirrors the loaded layout — one sentence over one button — so the panel
// keeps its height and only the promise fills in.
function PublishPanelLoadingState() {
  return (
    <PanelShell>
      <div aria-busy className="space-y-3">
        <div className="skeleton h-3 w-4/5" />
        <div className="skeleton h-8 w-24" />
      </div>
    </PanelShell>
  );
}

/**
 * No connection: the pitch, in the same shape as the writer's missing-key
 * state. Publishing is the step where rankloop writes to something the user
 * owns, so the sell is what the loop does for the page rather than what the
 * form needs — the hub and the links are the part nobody does by hand.
 */
function PublishSetupPitch({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-base-content/70">
        Connect your site and rankloop lands this draft on it &mdash; the hub
        page first, then links to it from the posts you already have.
      </p>
      <Link
        to="/p/$projectId/articles"
        params={{ projectId }}
        className="link link-primary text-sm font-medium"
      >
        Set up publishing &rarr;
      </Link>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
      {children}
    </p>
  );
}

/**
 * After the write: the three things rankloop touched, as the site sees them.
 *
 * The URL is the only external link on the screen and goes through
 * SafeExternalLink; the hub and the injected links render as paths, because a
 * path is what you check against your own site and a full URL five times over
 * is noise.
 */
function PublishReceiptLine({
  published,
}: {
  published: NonNullable<PublishPlan["published"]>;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <FieldLabel>Live at</FieldLabel>
        {published.url ? (
          <SafeExternalLink
            url={published.url}
            label={publishedPath(published.url)}
            className="link link-hover inline-flex max-w-full items-center gap-1 break-all font-mono text-xs"
          />
        ) : (
          <p className="text-sm text-base-content/60">
            The target didn&rsquo;t return a URL. It will show here once a crawl
            finds the page.
          </p>
        )}
        {published.url && published.urlConfidence === "unverified" ? (
          <p className="text-xs text-base-content/55">
            Computed from the page type&rsquo;s URL pattern &mdash; the target
            didn&rsquo;t confirm it.
          </p>
        ) : null}
        {/* Google's verdict on this one URL. A page that was crawled and
            declined is the failure the whole throttle exists to catch, so it
            reads in the error tone here rather than as one more grey line. */}
        {published.indexation ? (
          <p
            className={`text-xs ${
              isIndexationFailure(published.indexation)
                ? "text-error"
                : "text-base-content/55"
            }`}
          >
            {indexationVerdictLine(published.indexation)}
          </p>
        ) : null}
      </div>

      {published.hubPath ? (
        <div className="space-y-1">
          <FieldLabel>Hub</FieldLabel>
          <p className="font-mono text-xs">{published.hubPath}</p>
        </div>
      ) : null}

      <div className="space-y-1">
        <FieldLabel>Links injected</FieldLabel>
        {published.links.length === 0 ? (
          <p className="text-sm text-base-content/60">
            None &mdash; the hub is the only page pointing at it.
          </p>
        ) : (
          <ul className="space-y-1">
            {published.links.map((link) => (
              <li
                key={link.path}
                className="flex flex-wrap items-baseline gap-x-3"
              >
                <span className="font-mono text-xs">{link.path}</span>
                {link.title ? (
                  <span className="max-w-md truncate text-xs text-base-content/50">
                    {link.title}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * What happens when you press the button, stated before the button.
 *
 * The sentence is assembled from the plan the workflow will actually execute —
 * same hub, same neighbours, same post status — so it is a description of the
 * next thirty seconds rather than a description of the feature.
 */
export function RankloopPublishPanel({
  projectId,
  articleId,
  status,
}: {
  projectId: string;
  articleId: string;
  status: string;
}) {
  const queryClient = useQueryClient();

  const planQuery = useQuery({
    queryKey: ["rankloopPublishPlan", projectId, articleId],
    queryFn: () => getRankloopPublishPlan({ data: { projectId, articleId } }),
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      publishRankloopArticle({ data: { projectId, articleId } }),
    onSuccess: () => {
      captureClientEvent("rankloop_publish:article_publish", {
        project_id: projectId,
      });
      toast.success("Publishing started");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't publish the draft. Try again.",
        ),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopArticle", projectId, articleId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopPublishPlan", projectId, articleId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopPublishedArticles", projectId],
      });
    },
  });

  if (planQuery.isPending) return <PublishPanelLoadingState />;

  if (planQuery.isError) {
    return (
      <PanelShell>
        <p className="text-sm text-base-content/60">
          {getStandardErrorMessage(
            planQuery.error,
            "Couldn't load the publish plan. Try again shortly.",
          )}
        </p>
      </PanelShell>
    );
  }

  const plan = planQuery.data;

  if (plan.published) {
    return (
      <PanelShell>
        <PublishReceiptLine published={plan.published} />
      </PanelShell>
    );
  }

  // No connection is not an error state — nothing has gone wrong, the loop
  // just has nowhere to land yet.
  if (!plan.capabilities) {
    return (
      <PanelShell>
        <PublishSetupPitch projectId={projectId} />
      </PanelShell>
    );
  }

  const caveat = publishLinkCaveat({
    linkInjection: plan.linkInjection,
    linkTargetCount: plan.linkTargets.length,
  });
  const publishing = status === "publishing" || publishMutation.isPending;

  return (
    <PanelShell>
      <div className="space-y-3">
        <p className="text-sm text-base-content/80">
          {publishPlanSentence({
            action: plan.action,
            target: plan.target,
            hub: plan.hub,
            linkTargetCount: plan.linkTargets.length,
          })}
        </p>

        {caveat ? (
          <p className="text-xs text-base-content/55">{caveat}</p>
        ) : null}

        {/* Preflight re-runs the gate, so a reason here is the laws or the
            trust dial talking, not a guess this screen made. Saying it beats
            offering a button that bounces the article back to review. */}
        {plan.blockedReason ? (
          <p className="text-sm text-base-content/70">{plan.blockedReason}</p>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={publishing}
            onClick={() => publishMutation.mutate()}
          >
            {publishing ? <Loader2 className="size-3 animate-spin" /> : null}
            {publishing ? "Publishing…" : "Publish"}
          </button>
        )}
      </div>
    </PanelShell>
  );
}
