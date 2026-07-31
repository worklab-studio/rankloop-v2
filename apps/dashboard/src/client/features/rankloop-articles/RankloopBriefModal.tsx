import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/client/components/Markdown";
import { Modal } from "@/client/components/Modal";
import {
  formatCost,
  serpSourceStamp,
} from "@/client/features/rankloop-articles/netNewDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { getRankloopProposals } from "@/serverFunctions/rankloopProposals";
import {
  getRankloopBrief,
  getRankloopBriefCost,
} from "@/serverFunctions/rankloopWriting";

type ProposalRow = Awaited<ReturnType<typeof getRankloopProposals>>[number];
type CostPreview = Awaited<ReturnType<typeof getRankloopBriefCost>>;

function BriefLoadingState() {
  return (
    <div aria-busy className="space-y-2 rounded-lg border border-base-300 p-4">
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-3 w-full" />
      <div className="skeleton h-3 w-full" />
      <div className="skeleton h-3 w-4/5" />
      <div className="skeleton h-3 w-1/2" />
    </div>
  );
}

/**
 * The price, stated before anything is bought.
 *
 * The cost endpoint is read-only, so this card is on screen before a single
 * provider call could have happened — and the brief underneath is already
 * complete without the SERP. Buying one adds the angle-gap and People-Also-Ask
 * material; declining costs the user nothing and still yields a usable brief.
 */
function SerpCostCard({
  cost,
  fetching,
  onAllow,
}: {
  cost: CostPreview;
  fetching: boolean;
  onAllow: () => void;
}) {
  // Keyless installs land here: nothing is cached and nothing can be bought,
  // so offering a button would be a lie. Say what the brief does instead.
  if (!cost.serpProviderConfigured) {
    return (
      <p className="rounded-lg border border-base-300 bg-base-200/30 p-3 text-sm text-base-content/70">
        No SERP is cached for &ldquo;{cost.keyword}&rdquo; and no SERP provider
        is configured, so the brief below tells the writer to work from the
        topic itself.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-base-300 bg-base-200/30 p-3">
      <p className="text-sm">
        No SERP is cached for &ldquo;{cost.keyword}&rdquo;, so the brief below
        has no angle-gap or People Also Ask section.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-sm"
          disabled={fetching}
          onClick={onAllow}
        >
          {fetching ? <Loader2 className="size-3 animate-spin" /> : null}
          Fetch the SERP
        </button>
        <span className="text-xs text-base-content/55">
          {formatCost(cost.costUsd)} once &mdash; it is stored and reused by
          every later brief on this keyword.
        </span>
      </div>
    </div>
  );
}

function CopyBriefButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Clipboard not available");
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Brief copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  return (
    <button type="button" className="btn btn-sm" onClick={handleCopy}>
      {copied ? (
        <Check className="size-3 text-success" />
      ) : (
        <Copy className="size-3" />
      )}
      Copy brief
    </button>
  );
}

/**
 * The brief, on screen before a single word is written. The markdown is
 * assembled — from the keyword row, a cached SERP, the page type's contract
 * and pages that actually exist — never invented, so reading it is the whole
 * review: if the brief is wrong, the post would have been wrong.
 */
export function RankloopBriefModal({
  projectId,
  proposal,
  onClose,
}: {
  projectId: string;
  proposal: ProposalRow;
  onClose: () => void;
}) {
  // Opt-in, and part of the query key: the first render never spends, and the
  // fetched brief caches beside the unfetched one instead of replacing it.
  const [allowSerpFetch, setAllowSerpFetch] = useState(false);

  // Runs first and costs nothing — the drawer knows the price before it has
  // asked for anything that could incur one.
  const costQuery = useQuery({
    queryKey: ["rankloopBriefCost", projectId, proposal.id],
    queryFn: () =>
      getRankloopBriefCost({ data: { projectId, proposalId: proposal.id } }),
  });
  const cost = costQuery.data ?? null;

  const briefQuery = useQuery({
    queryKey: ["rankloopBrief", projectId, proposal.id, allowSerpFetch],
    queryFn: () =>
      getRankloopBrief({
        data: { projectId, proposalId: proposal.id, allowSerpFetch },
      }),
  });
  const brief = briefQuery.data ?? null;

  const spend = brief && brief.costUsd > 0 ? formatCost(brief.costUsd) : null;

  return (
    <Modal
      onClose={onClose}
      labelledBy="rankloop-brief-title"
      maxWidth="max-w-3xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id="rankloop-brief-title" className="text-lg font-semibold">
            Writer brief
          </h3>
          <p
            className="truncate text-sm text-base-content/70"
            title={proposal.target}
          >
            {proposal.target}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      {cost && !allowSerpFetch && cost.cachedSerpSource === null ? (
        <SerpCostCard
          cost={cost}
          fetching={briefQuery.isFetching}
          onAllow={() => setAllowSerpFetch(true)}
        />
      ) : null}

      {briefQuery.isPending ? <BriefLoadingState /> : null}

      {briefQuery.isError ? (
        <div className="alert alert-error">
          <span className="text-sm">
            {getStandardErrorMessage(
              briefQuery.error,
              "Couldn't assemble the brief. Try again.",
            )}
          </span>
        </div>
      ) : null}

      {brief ? (
        <>
          {/* `prose prose-sm` per spec 0019; OpenSEO ships no typography
              plugin, so the Markdown component's per-element classes are what
              actually style the document. */}
          <Markdown className="prose prose-sm max-h-[55vh] overflow-y-auto rounded-lg border border-base-300 bg-base-200/20 p-4 text-sm">
            {brief.markdown}
          </Markdown>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-base-content/45">
              this is exactly what the writer receives &middot;{" "}
              {serpSourceStamp(brief.serpSource)}
              {spend ? ` · ${spend} spent` : ""}
            </p>
            <CopyBriefButton markdown={brief.markdown} />
          </div>
        </>
      ) : null}
    </Modal>
  );
}
