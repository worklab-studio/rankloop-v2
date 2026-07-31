import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Markdown } from "@/client/components/Markdown";

type EditorTab = "draft" | "markdown";

function EditorTabButton({
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

/**
 * The draft, readable and editable.
 *
 * The markdown tab is deliberately a bare textarea: what the gate parses is
 * the raw file — frontmatter and all — so an editor that hid the frontmatter
 * behind a rich surface would be hiding half of what the laws read.
 *
 * "Save & re-check" re-runs the gate and nothing else. That is the whole
 * reason `drafts` mode is livable: fixing one sentence a law tripped on must
 * cost a round-trip, not another generation.
 */
export function RankloopArticleEditor({
  articleId,
  content,
  isSaving,
  onSave,
}: {
  articleId: string;
  content: string | null;
  isSaving: boolean;
  onSave: (markdown: string) => void;
}) {
  const [tab, setTab] = useState<EditorTab>("draft");
  const [markdown, setMarkdown] = useState(content ?? "");
  // Seed from the stored draft once per article. Re-seeding on every poll
  // would throw away whatever the user is halfway through typing.
  const [seededFor, setSeededFor] = useState(articleId);
  if (seededFor !== articleId) {
    setMarkdown(content ?? "");
    setSeededFor(articleId);
  }

  const dirty = markdown !== (content ?? "");

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <div className="flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" className="tabs tabs-border w-fit">
          <EditorTabButton
            active={tab === "draft"}
            onClick={() => setTab("draft")}
            label="Draft"
          />
          <EditorTabButton
            active={tab === "markdown"}
            onClick={() => setTab("markdown")}
            label="Markdown"
          />
        </div>
        {tab === "markdown" ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-base-content/55">
              Re-runs the laws only &mdash; no model call, no spend.
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!dirty || isSaving}
              onClick={() => onSave(markdown)}
            >
              {isSaving ? <Loader2 className="size-3 animate-spin" /> : null}
              Save &amp; re-check
            </button>
          </div>
        ) : null}
      </div>

      {tab === "markdown" ? (
        <div className="p-4">
          <textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            spellCheck={false}
            aria-label="Article markdown"
            className="textarea textarea-bordered min-h-[60vh] w-full font-mono leading-relaxed"
          />
        </div>
      ) : content ? (
        // `prose prose-sm` per spec 0020; OpenSEO ships no typography plugin,
        // so the Markdown component's per-element classes are what actually
        // style the document.
        <Markdown className="prose prose-sm p-4 text-sm">{content}</Markdown>
      ) : (
        <p className="p-6 text-sm text-base-content/60">
          No draft stored yet. It appears here the moment the generation step
          returns.
        </p>
      )}
    </div>
  );
}
