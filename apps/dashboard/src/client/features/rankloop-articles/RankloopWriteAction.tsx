import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import {
  articleStepLabel,
  isArticleRunning,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
import {
  writeActionState,
  type WriterMode,
} from "@/client/features/rankloop-articles/writerMode.logic";
import { openrouterHelpLinkOptions } from "@/client/navigation/items";
import type { getRankloopArticles } from "@/serverFunctions/rankloopWriter";

type ArticleRow = Awaited<ReturnType<typeof getRankloopArticles>>[number];

/**
 * Without a key: the pitch, never a button that fails when pressed.
 *
 * The benefit clause is the whole reason the key is the user's own — rankloop
 * writes with it, so the words and the bill belong to whoever owns the site.
 */
function WriterSetupPitch() {
  return (
    <Link
      {...openrouterHelpLinkOptions}
      className="link link-primary text-sm font-medium"
      title="rankloop drafts with your own OpenRouter key, so the words and the spend stay yours."
    >
      Add a key to write →
    </Link>
  );
}

/**
 * Agent mode: the row is claimed by something that is not this screen.
 *
 * Deliberately not a disabled button. There is no action to take here — the
 * proposal stays approved until the agent reports the post it wrote, and a
 * greyed-out Write would read as a thing that is temporarily broken rather
 * than a thing that is somebody else's job.
 */
function WaitingForAgent() {
  return (
    <span
      className="text-xs text-base-content/55"
      title="Your agent pulls this proposal and its brief over MCP, writes the page in your repo, and reports it back. Nothing here spends."
    >
      Waiting for your agent
    </span>
  );
}

/**
 * The row action on an approved net-new proposal.
 *
 * Four shapes, one slot, chosen by `writeActionState`: the waiting line in
 * agent mode, the setup pitch when no key is configured, the live step gerund
 * once a workflow owns the article, and otherwise a link into the draft that
 * already exists — pressing Write twice on the same proposal is impossible
 * from here, which matches the partial unique that would refuse it anyway.
 */
export function RankloopWriteAction({
  projectId,
  article,
  writerMode,
  providerConfigured,
  isPending,
  onWrite,
}: {
  projectId: string;
  article: ArticleRow | undefined;
  writerMode: WriterMode;
  providerConfigured: boolean;
  isPending: boolean;
  onWrite: () => void;
}) {
  const state = writeActionState({ writerMode, article, providerConfigured });

  // `state` is "open-draft" exactly when there is an article; branching on the
  // row itself is what narrows it for the link below.
  if (article) {
    const step = isArticleRunning(article.status)
      ? articleStepLabel(article.status, article.lawReport)
      : null;
    return (
      <div className="flex items-center justify-end gap-2">
        {step ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-base-content/60">
            <Loader2 className="size-3 animate-spin" />
            {step}
          </span>
        ) : null}
        <Link
          to="/p/$projectId/articles/$articleId"
          params={{ projectId, articleId: article.id }}
          className="btn btn-ghost btn-sm"
        >
          Open draft
        </Link>
      </div>
    );
  }

  if (state === "waiting-agent") return <WaitingForAgent />;
  if (state === "add-key") return <WriterSetupPitch />;

  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={isPending}
      onClick={onWrite}
    >
      {isPending ? <Loader2 className="size-3 animate-spin" /> : null}
      Write
    </button>
  );
}
