/** `rankloop-local doctor` — where am I, and what is blocking me.
 *
 * The pipeline has layers, and every one of them can be individually fine
 * while the whole thing does nothing: the dashboard is up but the project
 * has no keywords; the keywords exist but no page type is approved; the
 * plan is approved but no title is. Before this existed the only feedback
 * was "No approved proposals are waiting", which is true and useless — it
 * names the last gate, not the first one that is actually shut.
 *
 * So doctor reports EVERY layer, in order, and points at the first one that
 * blocks. Pure: the caller gathers the facts. */

export type CheckState = "ok" | "blocked" | "warn";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** The single next action. Null when nothing is needed. */
  fix: string | null;
}

export interface DoctorFacts {
  /** Local side. */
  inGitRepo: boolean;
  configPath: string;
  configExists: boolean;
  projectId: string | null;
  writerCommand: string;
  writerOnPath: boolean;
  repoConfigured: boolean;
  repoPathExists: boolean;
  /** Server side. Null when the dashboard could not be reached at all. */
  server: string;
  reachable: boolean;
  projectFound: boolean;
  writerMode: string | null;
  /** Pipeline state, from rankloop_status and rankloop_proposals. Null when
   *  unreachable. Every field here is something those two tools actually
   *  return — inventing a "pages studied" number the server never sent
   *  would make doctor report a healthy pipeline for a dead one, which is
   *  the exact failure it exists to prevent. */
  pipeline: {
    /** Posts owed today; null when the quota is off. */
    owed: number | null;
    /** How many net-new proposals the loop may still create. */
    slots: number;
    /** The server's own explanation for why there is nothing to do. */
    reason: string | null;
    /** Page types held back, with why. */
    exclusions: { name: string; reason: string }[];
    approvedProposals: number;
    unwrittenProposals: number;
  } | null;
}

export function diagnose(facts: DoctorFacts): Check[] {
  const checks: Check[] = [];

  // ---- local ----
  checks.push(
    facts.configExists && facts.projectId
      ? {
          name: "Config",
          state: "ok",
          detail: `${facts.configPath} → project ${facts.projectId.slice(0, 8)}…`,
          fix: null,
        }
      : {
          name: "Config",
          state: "blocked",
          detail: facts.configExists
            ? "no projectId set"
            : `no config at ${facts.configPath}`,
          fix: "Run `rankloop-local init` inside your website repo.",
        },
  );

  checks.push(
    facts.writerOnPath
      ? { name: "Writer CLI", state: "ok", detail: `\`${facts.writerCommand}\` found`, fix: null }
      : {
          name: "Writer CLI",
          state: "blocked",
          detail: `\`${facts.writerCommand}\` is not on your PATH`,
          fix: `Install it, or set write.command in ${facts.configPath} to a CLI you have.`,
        },
  );

  if (facts.repoConfigured) {
    checks.push(
      facts.repoPathExists
        ? {
            name: "Your repo",
            state: "ok",
            detail: "found — posts will be committed and pushed",
            fix: null,
          }
        : {
            name: "Your repo",
            state: "blocked",
            detail: "repo.path in your config does not exist",
            fix: `Fix repo.path in ${facts.configPath}.`,
          },
    );
  } else {
    // Not a failure. Draft mode is the honest default for a site with no
    // repo — Framer, Webflow, Wix — and for anyone who wants to read the
    // first few posts before letting anything push.
    checks.push({
      name: "Publishing",
      state: "warn",
      detail: "draft mode — gated files land on disk, nothing is pushed",
      fix: "Add a `repo` block to your config to commit and push automatically.",
    });
  }

  // ---- server ----
  if (!facts.reachable) {
    checks.push({
      name: "Dashboard",
      state: "blocked",
      detail: `nothing answering at ${facts.server}`,
      fix: "Start it: `cd apps/dashboard && npm run dev` (leave it running).",
    });
    // Everything below is unknowable without it; stop rather than guess.
    return checks;
  }
  checks.push({ name: "Dashboard", state: "ok", detail: facts.server, fix: null });

  if (!facts.projectFound) {
    checks.push({
      name: "Project",
      state: "blocked",
      detail: "the configured projectId is not on this dashboard",
      fix: "Check the id in your dashboard URL (/p/<id>) and update your config.",
    });
    return checks;
  }

  checks.push(
    facts.writerMode === "agent"
      ? { name: "Writer mode", state: "ok", detail: "agent — your CLI writes", fix: null }
      : {
          name: "Writer mode",
          state: "blocked",
          detail: `"${facts.writerMode ?? "unknown"}" — the dashboard's own writer owns this project`,
          fix: "Set it to agent in Connect → Writing.",
        },
  );

  // ---- pipeline ----
  const p = facts.pipeline;
  if (!p) return checks;

  // The server's own words for why the loop is idle. This is the single
  // most useful line doctor can print, because it is the same sentence the
  // dashboard shows and it already knows which gate is shut.
  if (p.reason === null) {
    checks.push({
      name: "Quota",
      state: "ok",
      detail:
        p.owed === null
          ? `${p.slots} slot(s) available`
          : `${p.owed} owed today, ${p.slots} slot(s)`,
      fix: null,
    });
  } else {
    const verdict = quotaVerdict(p.reason);
    checks.push({
      name: "Quota",
      state: verdict.state,
      detail: p.reason,
      fix: verdict.fix,
    });
  }

  for (const exclusion of p.exclusions) {
    checks.push({
      name: "Held back",
      state: "warn",
      detail: `${exclusion.name}: ${exclusion.reason}`,
      fix: null,
    });
  }

  checks.push(
    p.unwrittenProposals > 0
      ? {
          name: "Approved titles",
          state: "ok",
          detail: `${p.unwrittenProposals} waiting to be written`,
          fix: null,
        }
      : {
          name: "Approved titles",
          state: p.approvedProposals > 0 ? "warn" : "blocked",
          detail:
            p.approvedProposals > 0
              ? "every approved title already has a draft"
              : "no titles approved yet",
          fix:
            p.approvedProposals > 0
              ? "Nothing to do until the next batch is proposed."
              : "Dashboard → Publish → approve some titles (Gate 2).",
        },
  );

  return checks;
}

/**
 * The reasons the server actually emits, and what each one means to do.
 *
 * Matched as whole known strings rather than by keyword. The first version
 * of this matched any reason containing "quota" and told a user whose quota
 * was OFF that their quota was already MET — opposite meanings, same word,
 * and confidently wrong advice is worse than none. Anything unrecognised is
 * passed through to the dashboard instead of guessed at.
 */
const QUOTA_REASONS: { match: (r: string) => boolean; state: CheckState; fix: string }[] = [
  {
    // Not a fault: the daily loop is deliberately off and titles are
    // proposed by hand. Calling it blocked sends the user hunting a bug.
    match: (r) => r.includes("quota off"),
    state: "warn",
    fix: "Daily proposing is off. Turn it on in Connect → Automation, or propose titles yourself in Publish.",
  },
  {
    match: (r) => r.includes("no planned keywords are bound to an approved page type"),
    state: "blocked",
    fix: "Dashboard → Plan → approve a page type, and make sure keywords are bound to it (Gate 1).",
  },
  {
    match: (r) => r.includes("waiting on a data source"),
    state: "blocked",
    fix: "Your approved page types are programmatic and have no dataset yet — no data row, no page.",
  },
  {
    // The system working as designed: rankloop slows itself until more of
    // what it published is indexed.
    match: (r) => r.includes("decision-suppression window"),
    state: "warn",
    fix: "Every candidate was recently decided on. rankloop is waiting before re-proposing. Nothing to fix.",
  },
  {
    match: (r) => r.includes("indexation") || r.includes("throttle"),
    state: "warn",
    fix: "rankloop is throttling itself until more of what you published gets indexed. Nothing to fix.",
  },
];

function quotaVerdict(reason: string): { state: CheckState; fix: string } {
  const lower = reason.toLowerCase();
  const known = QUOTA_REASONS.find((entry) => entry.match(lower));
  return (
    known ?? {
      state: "blocked" as CheckState,
      fix: "Open the dashboard — it shows this same reason with the button to clear it.",
    }
  );
}

/** The one line that answers "what do I do now". */
export function nextAction(checks: readonly Check[]): string {
  const blocked = checks.find((c) => c.state === "blocked");
  if (blocked) return `${blocked.name}: ${blocked.fix ?? blocked.detail}`;
  const ready = checks.every((c) => c.state !== "blocked");
  return ready
    ? "Everything is ready — run `rankloop-local run`."
    : "Nothing is blocking, but nothing is waiting either.";
}

export function renderChecks(checks: readonly Check[], next: string): string {
  const icon = (s: CheckState) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const lines = checks.map(
    (c) => `  ${icon(c.state)} ${c.name.padEnd(16)} ${c.detail}`,
  );
  const fixes = checks
    .filter((c) => c.state !== "ok" && c.fix)
    .map((c) => `  → ${c.fix}`);
  return [
    "",
    ...lines,
    "",
    ...(fixes.length > 0 ? [...fixes, ""] : []),
    `Next: ${next}`,
    "",
  ].join("\n");
}
