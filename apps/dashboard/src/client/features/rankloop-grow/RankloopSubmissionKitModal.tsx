import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { saveRankloopKit } from "@/serverFunctions/rankloopArmory";
import type { SubmissionKit } from "@/shared/submission-kit";

// The kit is filled once and every listing renders from it. The counters
// below are the whole point of the form: directories cut at their limit
// without telling you, so the limit has to be visible while you write.

const LIMITS = { tagline: 60, shortDescription: 160, longDescription: 500 };

function CharCount({ value, limit }: { value: string; limit: number }) {
  const over = value.length > limit;
  return (
    <span
      className={`text-[11px] tabular-nums ${over ? "text-warning" : "text-base-content/40"}`}
    >
      {value.length}/{limit}
      {/* Over the limit is not an error — the payload shortens at a word
          boundary and says so. Blocking the save would make the user do the
          trimming a machine can do correctly. */}
      {over ? " · will be shortened" : ""}
    </span>
  );
}

function Field({
  label, value, onChange, limit, placeholder, textarea, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  limit?: number;
  placeholder?: string;
  textarea?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {limit ? <CharCount value={value} limit={limit} /> : null}
      </span>
      {textarea ? (
        <textarea
          className="textarea textarea-bordered mt-1 h-20 w-full text-sm"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="input input-bordered mt-1 h-9 w-full text-sm"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint ? (
        <span className="mt-0.5 block text-[11px] text-base-content/50">{hint}</span>
      ) : null}
    </label>
  );
}

export function RankloopSubmissionKitModal({
  projectId,
  kit,
  defaults,
  onClose,
}: {
  projectId: string;
  kit: SubmissionKit | null;
  defaults: { name: string; url: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SubmissionKit>(() => ({
    name: kit?.name || defaults.name,
    tagline: kit?.tagline ?? "",
    shortDescription: kit?.shortDescription ?? "",
    longDescription: kit?.longDescription ?? "",
    url: kit?.url || defaults.url,
    logoUrl: kit?.logoUrl ?? null,
    categories: kit?.categories ?? [],
    pricing: kit?.pricing ?? null,
    founder: kit?.founder ?? null,
    launchDate: kit?.launchDate ?? null,
  }));

  const save = useMutation({
    mutationFn: () => saveRankloopKit({ data: { projectId, kit: draft } }),
    onSuccess: (board) => {
      queryClient.setQueryData(["rankloopArmory", projectId], board);
      onClose();
    },
  });

  const set = <K extends keyof SubmissionKit>(key: K, value: SubmissionKit[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <dialog className="modal modal-open" onClose={onClose}>
      <div className="modal-box max-w-2xl">
        <h3 className="text-lg font-semibold">Your submission kit</h3>
        <p className="mt-1 text-sm text-base-content/70">
          Fill this once. Every listing on the board renders from it, cut to
          that directory&rsquo;s limits at a word boundary.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Product name" value={draft.name} onChange={(v) => set("name", v)} />
          <Field
            label="Tagline"
            value={draft.tagline}
            onChange={(v) => set("tagline", v)}
            limit={LIMITS.tagline}
            placeholder="The one line directories ask for first"
          />
          <Field
            label="Short description"
            value={draft.shortDescription}
            onChange={(v) => set("shortDescription", v)}
            limit={LIMITS.shortDescription}
            textarea
            hint="Meta-description length. The most commonly requested field."
          />
          <Field
            label="Long description"
            value={draft.longDescription}
            onChange={(v) => set("longDescription", v)}
            limit={LIMITS.longDescription}
            textarea
            hint="The “tell us about your product” box."
          />
          <Field label="URL" value={draft.url} onChange={(v) => set("url", v)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Categories"
              value={draft.categories.join(", ")}
              onChange={(v) =>
                set(
                  "categories",
                  v.split(",").map((c) => c.trim()).filter((c) => c !== ""),
                )
              }
              placeholder="SEO, Developer tools"
            />
            <Field
              label="Pricing"
              value={draft.pricing ?? ""}
              onChange={(v) => set("pricing", v || null)}
              placeholder="Free, Freemium, $19/mo…"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Logo URL"
              value={draft.logoUrl ?? ""}
              onChange={(v) => set("logoUrl", v || null)}
              placeholder="https://…/logo.png"
            />
            <Field
              label="Founder"
              value={draft.founder ?? ""}
              onChange={(v) => set("founder", v || null)}
            />
          </div>
        </div>

        {save.isError ? (
          <p className="mt-3 text-xs text-error">
            {getStandardErrorMessage(save.error)}
          </p>
        ) : null}

        <div className="modal-action">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save kit"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>
          close
        </button>
      </form>
    </dialog>
  );
}
