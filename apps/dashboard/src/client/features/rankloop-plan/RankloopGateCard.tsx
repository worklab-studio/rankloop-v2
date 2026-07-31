import { useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Stat } from "@/client/features/dashboard/cardParts";
import {
  GATE_STAMP,
  gateTokenLabel,
  kdCeilingStamp,
  REDERIVE_DISABLED_TOOLTIP,
} from "@/client/features/rankloop-plan/keywordUniverseDisplay.logic";
import { tagChipClass } from "@/shared/tag-colors";
import type { GateCard } from "@/types/schemas/rankloopUniverse";

const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium";

function TokenChip({
  label,
  color,
  onRemove,
}: {
  label: string;
  color: "sky" | "slate";
  onRemove: () => void;
}) {
  return (
    <span className={`${chipBaseClass} ${tagChipClass(color)}`}>
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        className="opacity-60 transition-opacity hover:opacity-100"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function AddTokenInput({
  placeholder,
  onAdd,
}: {
  placeholder: string;
  onAdd: (token: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const token = value.trim();
        if (!token) return;
        onAdd(token);
        setValue("");
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="input input-bordered input-xs w-44"
      />
      <button type="submit" className="btn btn-ghost btn-xs">
        Add
      </button>
    </form>
  );
}

/**
 * The relevance gate, collapsed by default.
 *
 * Two things live here and both are the same promise: the tokens that decide
 * what counts as on-topic for this site were derived from the site's own
 * pages and queries — not guessed by a model — and the difficulty ceiling was
 * earned from what it already ranks for. Editing either is allowed; the cost
 * of editing the tokens is that re-derivation retires itself, which is why
 * that button explains its own disabled state instead of vanishing.
 */
export function RankloopGateCard({
  gate,
  saving,
  rederiving,
  onSave,
  onRederive,
}: {
  gate: GateCard;
  saving: boolean;
  rederiving: boolean;
  onSave: (input: { positives: string[]; negatives: string[] }) => void;
  onRederive: () => void;
}) {
  const [open, setOpen] = useState(false);

  const positives = gate.positives.map((entry) => entry.token);
  const save = (next: { positives?: string[]; negatives?: string[] }) =>
    onSave({
      positives: next.positives ?? positives,
      negatives: next.negatives ?? gate.negatives,
    });

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-base-300/30"
      >
        <span className="text-sm font-medium">
          Relevance gate ({gate.positives.length} token
          {gate.positives.length === 1 ? "" : "s"})
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-base-content/50 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <div className="space-y-5 border-t border-base-300 p-4">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
              On topic here
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {gate.positives.map((entry) => (
                <TokenChip
                  key={entry.token}
                  label={gateTokenLabel(entry)}
                  color="sky"
                  onRemove={() =>
                    save({
                      positives: positives.filter(
                        (token) => token !== entry.token,
                      ),
                    })
                  }
                />
              ))}
              {gate.positives.length === 0 ? (
                <span className="text-sm text-base-content/55">
                  No tokens yet &mdash; with none, the gate admits anything the
                  negatives don&rsquo;t veto.
                </span>
              ) : null}
            </div>
            <AddTokenInput
              placeholder="add a topic word"
              onAdd={(token) => save({ positives: [...positives, token] })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
              Never on topic
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {gate.negatives.map((token) => (
                <TokenChip
                  key={token}
                  label={token}
                  color="slate"
                  onRemove={() =>
                    save({
                      negatives: gate.negatives.filter(
                        (entry) => entry !== token,
                      ),
                    })
                  }
                />
              ))}
            </div>
            <AddTokenInput
              placeholder="add a junk word"
              onAdd={(token) => save({ negatives: [...gate.negatives, token] })}
            />
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <Stat
              label="KD ceiling"
              value={gate.kdCeiling.toLocaleString("en-US")}
              sub={
                <p className="mt-0.5 max-w-md text-[11px] text-base-content/45">
                  {kdCeilingStamp(gate)}
                </p>
              }
            />
            <span
              className={gate.userEdited ? "tooltip tooltip-left" : undefined}
              data-tip={gate.userEdited ? REDERIVE_DISABLED_TOOLTIP : undefined}
            >
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={gate.userEdited || rederiving || saving}
                onClick={onRederive}
              >
                {rederiving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Re-derive
              </button>
            </span>
          </div>

          <p className="text-[11px] text-base-content/45">{GATE_STAMP}</p>
        </div>
      ) : null}
    </div>
  );
}
