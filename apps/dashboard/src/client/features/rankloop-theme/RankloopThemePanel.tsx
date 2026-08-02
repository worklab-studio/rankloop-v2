import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, GitPullRequest, Palette } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopTheme,
  openRankloopScaffold,
  previewRankloopScaffold,
} from "@/serverFunctions/rankloopTheme";

// Connect → Design (spec 0030). Extraction is a proposal, so every token is
// shown with the confidence behind it. A theme presented as fact is how a
// user ends up with a blog that looks *almost* like their site.

const CONFIDENCE_CLASS: Record<string, string> = {
  high: "bg-success/15 text-success",
  medium: "bg-warning/15 text-warning",
  low: "bg-base-300 text-base-content/60",
};

function Swatch({ value }: { value: string }) {
  if (!value.startsWith("#")) return null;
  return (
    <span
      className="size-6 shrink-0 rounded border border-base-300"
      style={{ background: value }}
    />
  );
}

export function RankloopThemePanel({ projectId }: { projectId: string }) {
  const themeQuery = useQuery({
    queryKey: ["rankloopTheme", projectId],
    queryFn: () => getRankloopTheme({ data: { projectId } }),
  });

  const previewMutation = useMutation({
    mutationFn: () => previewRankloopScaffold({ data: { projectId } }),
  });
  const openPr = useMutation({
    mutationFn: () => openRankloopScaffold({ data: { projectId } }),
  });

  if (themeQuery.isPending) return <div className="skeleton h-64 rounded-xl" />;
  if (themeQuery.isError) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm">
        {getStandardErrorMessage(themeQuery.error)}
      </div>
    );
  }

  const theme = themeQuery.data;
  const preview = previewMutation.data;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-base-300 bg-base-100 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Palette className="size-4" />
          Taken from {theme.domain ?? "your site"}
        </p>
        <p className="mt-1 text-xs text-base-content/60">
          Read from {theme.pagesRead} page{theme.pagesRead === 1 ? "" : "s"}.
          This is rankloop&rsquo;s best reading of your design, not a fact —
          check anything marked low.
        </p>

        <div className="mt-4 overflow-hidden rounded-lg border border-base-300">
          {theme.summary.map((token) => (
            <div
              key={token.name}
              className="flex items-center gap-3 border-b border-base-300 px-3 py-2 last:border-b-0"
            >
              <Swatch value={token.value} />
              <span className="w-32 shrink-0 text-xs font-medium">{token.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-base-content/70">
                {token.value}
              </span>
              <span
                className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${
                  CONFIDENCE_CLASS[token.confidence] ?? ""
                }`}
              >
                {token.confidence}
              </span>
            </div>
          ))}
        </div>

        {theme.needsReview.length > 0 ? (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Worth checking before you publish: {theme.needsReview.join(", ")}.
              Fonts are the hardest thing to read off a page — many site
              builders hide them behind generated variables.
            </span>
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-base-300 bg-base-100 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <GitPullRequest className="size-4" />
          Put a blog in your repo
        </p>
        <p className="mt-1 max-w-2xl text-xs text-base-content/60">
          rankloop opens a pull request adding a blog index and post page in
          your framework, styled with the tokens above. Nothing goes live
          until you merge it.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? "Checking your repo…" : "Check my repo"}
          </button>
          {preview && !preview.blocked ? (
            <button
              type="button"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={openPr.isPending}
              onClick={() => openPr.mutate()}
            >
              <GitPullRequest className="size-3.5" />
              {openPr.isPending ? "Opening…" : "Open the pull request"}
            </button>
          ) : null}
        </div>

        {previewMutation.isError ? (
          <p className="mt-3 text-xs text-error">
            {getStandardErrorMessage(previewMutation.error)}
          </p>
        ) : null}

        {preview ? (
          <div className="mt-4 space-y-2">
            <p className="text-xs">
              <span className="text-base-content/50">Detected:</span>{" "}
              <span className="font-medium">{preview.stackLabel}</span>
              {preview.stack.evidence.length > 0 ? (
                <span className="text-base-content/40">
                  {" — from "}
                  {preview.stack.evidence.join(", ")}
                </span>
              ) : null}
            </p>

            {/* An unrecognised repo says why, rather than showing a disabled
                button with no explanation. */}
            {preview.blocked ? (
              <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                {preview.blocked}
              </p>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-base-300 text-xs">
                {preview.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-center gap-3 border-b border-base-300 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {file.path}
                    </span>
                    <span className="shrink-0 text-base-content/50">
                      {file.exists ? "already exists — skipped" : file.purpose}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {preview.requiredDependency ? (
              <p className="text-xs text-base-content/60">
                Needs one dependency your repo doesn&rsquo;t have yet:{" "}
                <code>npm install {preview.requiredDependency}</code>. The PR
                says so too.
              </p>
            ) : null}
          </div>
        ) : null}

        {openPr.isError ? (
          <p className="mt-3 text-xs text-error">
            {getStandardErrorMessage(openPr.error)}
          </p>
        ) : null}

        {openPr.data ? (
          <a
            href={openPr.data.url}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-sm mt-3 gap-1"
          >
            View the pull request
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
