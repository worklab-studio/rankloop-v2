import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  costSentence,
  runningLabel,
} from "@/client/features/rankloop-plan/keywordUniverseDisplay.logic";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import type {
  HarvestConfig,
  UniverseSource,
} from "@/types/schemas/rankloopUniverse";

// One button per source, in the order a project should reach for them: the
// free memory it already owns, then the two that cost money, then the two
// free idea mines. Every button is the same endpoint with different steps
// enabled, so a run started here is indistinguishable from the weekly block's.

function SourceButton({
  label,
  note,
  primary,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  note?: string;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        className={`btn btn-sm ${primary ? "btn-primary" : ""}`}
        disabled={disabled}
        onClick={onClick}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {label}
      </button>
      {note ? (
        <p className="mt-1.5 text-xs text-base-content/55">{note}</p>
      ) : null}
    </div>
  );
}

// Without a key the metered buttons are disabled and say what the key would
// buy — never an error, and never a button that fails when pressed.
function MeteredSetupPitch() {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4">
      <p className="text-sm text-base-content/70">
        Add your DataForSEO API key to mine the keywords your competitors rank
        for and expand your best seeds. Search Console, autocomplete and
        harvested questions all run without one.
      </p>
      <Link
        {...dataforseoHelpLinkOptions}
        className="link link-primary mt-2 inline-block text-sm font-medium"
      >
        Open setup guide →
      </Link>
    </div>
  );
}

/**
 * Where the free question feeds read from. Opt-in and collapsed: there is no
 * default subreddit for a niche, and a harvest pointed at a guess fills the
 * backlog with other people's questions.
 */
function HarvestConfigPanel({
  config,
  onChange,
}: {
  config: HarvestConfig;
  onChange: (next: HarvestConfig) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-base-300/30"
      >
        <span className="text-sm font-medium">Question feeds</span>
        <ChevronDown
          className={`size-4 shrink-0 text-base-content/50 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-base-300 p-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">StackExchange site</span>
            <input
              type="text"
              value={config.stackExchangeSite ?? ""}
              onChange={(event) =>
                onChange({ ...config, stackExchangeSite: event.target.value })
              }
              placeholder="superuser.com"
              className="input input-bordered input-sm w-64"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Tags</span>
            <input
              type="text"
              value={config.stackExchangeTags.join(", ")}
              onChange={(event) =>
                onChange({
                  ...config,
                  stackExchangeTags: splitList(event.target.value),
                })
              }
              placeholder="espresso, grinders"
              className="input input-bordered input-sm w-full max-w-md"
            />
            <span className="text-xs text-base-content/55">
              Up to six, comma separated. Read 2 seconds apart.
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Subreddits</span>
            <input
              type="text"
              value={config.subreddits.join(", ")}
              onChange={(event) =>
                onChange({
                  ...config,
                  subreddits: splitList(event.target.value),
                })
              }
              placeholder="espresso, coffee"
              className="input input-bordered input-sm w-full max-w-md"
            />
            <span className="text-xs text-base-content/55">
              Up to three, without the r/. Reddit is read 20 seconds apart, so a
              harvest takes about a minute.
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function RankloopKeywordSources({
  running,
  runningSources,
  keyless,
  harvest,
  onHarvestChange,
  onStart,
}: {
  running: boolean;
  runningSources: readonly UniverseSource[];
  keyless: boolean;
  harvest: HarvestConfig;
  onHarvestChange: (next: HarvestConfig) => void;
  onStart: (source: UniverseSource) => void;
}) {
  const busyLabel = runningLabel(runningSources);
  const harvestConfigured =
    (Boolean(harvest.stackExchangeSite) &&
      harvest.stackExchangeTags.length > 0) ||
    harvest.subreddits.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <SourceButton
          primary
          label={running ? busyLabel : "Sync from Search Console"}
          note="Free · queries you already earn impressions for but rank below 10 on"
          busy={running}
          disabled={running}
          onClick={() => onStart("gsc")}
        />
        <SourceButton
          label="Find gaps"
          note={
            keyless
              ? "Needs a DataForSEO key"
              : `Metered · ${costSentence("gap")}`
          }
          disabled={running || keyless}
          onClick={() => onStart("gap")}
        />
        <SourceButton
          label="Expand seeds"
          note={
            keyless
              ? "Needs a DataForSEO key"
              : `Metered · ${costSentence("expansion")}`
          }
          disabled={running || keyless}
          onClick={() => onStart("expansion")}
        />
        <SourceButton
          label="Autocomplete"
          note="Free · Google, Bing and DuckDuckGo suggestions"
          disabled={running}
          onClick={() => onStart("autocomplete")}
        />
        <SourceButton
          label="Harvest questions"
          note={
            harvestConfigured
              ? "Free · StackExchange and Reddit, paced to their limits"
              : "Free · point it at a site and a subreddit first"
          }
          disabled={running || !harvestConfigured}
          onClick={() => onStart("harvest")}
        />
      </div>

      {keyless ? <MeteredSetupPitch /> : null}

      <HarvestConfigPanel config={harvest} onChange={onHarvestChange} />
    </div>
  );
}
