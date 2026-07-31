import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import {
  articleStepLabel,
  isArticleRunning,
} from "@/client/features/rankloop-articles/articleDisplay.logic";
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
 * The row action on an approved net-new proposal.
 *
 * Three shapes, one slot: the setup pitch when no key is configured, the live
 * step gerund once a workflow owns the article, and otherwise a link into the
 * draft that already exists — pressing Write twice on the same proposal is
 * impossible from here, which matches the partial unique that would refuse it
 * anyway.
 */
export function RankloopWriteAction({
  projectId,
  article,
  providerConfigured,
  isPending,
  onWrite,
}: {
  projectId: string;
  article: ArticleRow | undefined;
  providerConfigured: boolean;
  isPending: boolean;
  onWrite: () => void;
}) {
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

  if (!providerConfigured) return <WriterSetupPitch />;

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
