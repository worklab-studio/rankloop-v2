// Pure functions behind net-new selection (spec 0019): who is eligible, how
// many posts are owed today, which rows fill the batch, and what each pick
// says about itself. No I/O, no model call — unit-tested directly in
// selection.test.ts.
//
// The two decisions that matter are NOT made here. `computeQuota` (catch-up
// arithmetic) and `applyPoolMix` (one fresh-question slot per batch) come
// from @rankloop/engine, which is parity-tested against the Python engine
// that ran the original sites. Reimplementing either one in the app would
// fork the method silently — the tests would still pass and the product
// would quietly stop being rankloop.

import { applyPoolMix, computeQuota, type Slot } from "@rankloop/engine";
import { suppressedTargets } from "@/server/features/rankloop/proposals/suppression.logic";
import type { SuppressionInput } from "@/server/features/rankloop/proposals/suppression.logic";
import type { ProposalFactor } from "@/types/schemas/rankloopProposals";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A planned keyword_backlog row joined to the approved page type it is
 *  bound to — the only shape net-new selection ever looks at. */
export type NetNewCandidate = {
  backlogId: string;
  keyword: string;
  source: "gsc" | "gap" | "expansion" | "autocomplete" | "harvest" | "manual";
  score: number;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  /** 28-day Search Console impressions from notesJson (S5's imputation),
   *  null on rows no source ever measured. */
  impressions28: number | null;
  /** When the backlog row was written — the pool's recency ordering. */
  createdAt: string;
  pageTypeId: string;
  pageTypeName: string;
  pageTypeKind: "pseo" | "blog" | "hub";
  /** `dataSourceJson.mode`, null when the type has no data source yet. */
  dataSourceMode: string | null;
};

/** The writer dials selection reads. Mirrors writer_settings, minus the
 *  columns S7b owns. */
export type QuotaSettings = {
  postsPerDay: number;
  catchupCap: number;
  /** YYYY-MM-DD, or null for "quota off, manual only". */
  quotaStartDate: string | null;
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** The no-data-no-page law, arriving in S7a instead of ambushing the user in
 *  S6b: a pSEO template with no data source behind it cannot produce a page
 *  whose every cell says where it came from, so it produces nothing. The
 *  reason travels with the exclusion because a keyword that silently vanishes
 *  from the queue is indistinguishable from a bug. */
export const NEEDS_DATA_SOURCE_REASON =
  "needs a data source — see the page plan";

/** One approved page type that contributed no candidates, and why. */
export type NetNewExclusion = {
  pageTypeId: string;
  pageTypeName: string;
  keywordCount: number;
  reason: string;
};

/**
 * Split candidates into the ones a brief could actually ground and the ones
 * held back, grouped by the page type that held them back.
 *
 * Blog- and hub-kind types have no dataset to require: their grounding is the
 * SERP and the site's own corpus. Only pSEO instances promise a row per page.
 */
export function partitionCandidates(rows: NetNewCandidate[]): {
  eligible: NetNewCandidate[];
  exclusions: NetNewExclusion[];
} {
  const eligible: NetNewCandidate[] = [];
  const blocked = new Map<string, NetNewExclusion>();
  for (const row of rows) {
    if (row.pageTypeKind === "pseo" && row.dataSourceMode === null) {
      const entry = blocked.get(row.pageTypeId) ?? {
        pageTypeId: row.pageTypeId,
        pageTypeName: row.pageTypeName,
        keywordCount: 0,
        reason: NEEDS_DATA_SOURCE_REASON,
      };
      entry.keywordCount += 1;
      blocked.set(row.pageTypeId, entry);
      continue;
    }
    eligible.push(row);
  }
  return {
    eligible,
    exclusions: [...blocked.values()].toSorted((a, b) =>
      a.pageTypeName.localeCompare(b.pageTypeName),
    ),
  };
}

// ---------------------------------------------------------------------------
// The quota
// ---------------------------------------------------------------------------

/** What the header line and the run both read: what today owes, what is
 *  already in flight, and how many slots that leaves. */
type NetNewSlots = {
  /** Posts owed today, or null when the quota is off. */
  owed: number | null;
  /** Net-new proposals already proposed/approved/executing. */
  outstanding: number;
  slots: number;
  /** Why there is nothing to do. Null whenever `slots` is positive. */
  reason: string | null;
};

/**
 * Turn the quota into a number of slots for this run.
 *
 * Outstanding proposals are subtracted rather than ignored, and that is what
 * makes the run safe to fire twice in a morning: the quota's own evidence is
 * the published corpus, which does not move when a proposal is created, so a
 * raw `owed` would hand out the same debt on every tick until the queue was
 * unreadable. A proposal nobody has acted on IS the debt, already recorded.
 */
export function computeNetNewSlots(input: {
  settings: QuotaSettings;
  /** Publish dates from content_pages posts, YYYY-MM-DD. */
  publishedDates: string[];
  outstanding: number;
  /** YYYY-MM-DD. */
  today: string;
  /** Manual ceiling from the caller; absent means the quota decides alone. */
  limit?: number;
}): NetNewSlots {
  const owed = computeQuota(
    {
      startDate: input.settings.quotaStartDate ?? undefined,
      postsPerDay: input.settings.postsPerDay,
      catchupCap: input.settings.catchupCap,
    },
    input.publishedDates,
    input.today,
  );
  if (owed === null) {
    return {
      owed: null,
      outstanding: input.outstanding,
      slots: 0,
      reason: "quota off — propose manually",
    };
  }

  const remaining = Math.max(0, owed - input.outstanding);
  const slots =
    input.limit === undefined ? remaining : Math.min(remaining, input.limit);
  if (slots > 0) {
    return { owed, outstanding: input.outstanding, slots, reason: null };
  }
  return {
    owed,
    outstanding: input.outstanding,
    slots: 0,
    reason:
      owed === 0
        ? "nothing owed today — the quota is met"
        : "today's quota is already in the queue",
  };
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

type NetNewPick = NetNewCandidate & { slot: Slot };

/**
 * Fill the batch: score order, then the engine's pool mix over it.
 *
 * Suppressed keywords are dropped BEFORE both, so a declined keyword can
 * neither win a scored slot nor sneak back in through the pool — the S3a
 * decision window is about the keyword, not about how it was chosen.
 *
 * Pool candidates are harvest-sourced rows, newest first: a question someone
 * asked last week is worth more than the same question asked in March, and
 * these rows carry neutral prior scores that would otherwise never outrank a
 * priced keyword.
 */
export function selectNetNew(input: {
  candidates: NetNewCandidate[];
  n: number;
  suppression: SuppressionInput;
}): NetNewPick[] {
  if (input.n <= 0) return [];
  const suppressed = suppressedTargets(input.suppression, "write_new");
  const open = input.candidates.filter((row) => !suppressed.has(row.keyword));

  // The keyword breaks score ties so two runs over an unchanged backlog
  // propose the same batch — a queue that reshuffles itself is a queue nobody
  // trusts they have already read.
  const scored = open
    .toSorted((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword))
    .slice(0, input.n);

  const pool = open
    .filter((row) => row.source === "harvest")
    .toSorted(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.score - a.score,
    );

  return applyPoolMix(scored, pool, input.n);
}

// ---------------------------------------------------------------------------
// What a pick says about itself
// ---------------------------------------------------------------------------

/** The one placeholder a page type's title pattern binds — the title-side
 *  twin of the `{slug}` in its urlPattern. */
const KEYWORD_PLACEHOLDER = "{keyword}";

/** Today every approved type's title pattern is the bare keyword: page_types
 *  stores a URL pattern and no title pattern, and inventing a headline here
 *  would promise an angle the writer has not read the SERP for yet. Rendered
 *  through the placeholder anyway so that the day a type carries its own
 *  pattern, this is the only line that changes. */
const DEFAULT_TITLE_PATTERN = KEYWORD_PLACEHOLDER;

/** Deterministic working title. Sentence case, not title case: the keyword is
 *  a phrase a person typed, and Title Casing It Like This is the tell of a
 *  machine that wrote the headline. */
export function renderTitle(
  keyword: string,
  pattern: string = DEFAULT_TITLE_PATTERN,
): string {
  const filled = pattern
    .split(KEYWORD_PLACEHOLDER)
    .join(keyword.charAt(0).toUpperCase() + keyword.slice(1))
    .trim();
  return filled || keyword;
}

/** How each source reads on an evidence chip. Off the column's own enum, so
 *  adding a source to the schema is a compile error here rather than a chip
 *  that renders the raw column value. */
const SOURCE_LABEL: Readonly<Record<NetNewCandidate["source"], string>> = {
  gsc: "Search Console",
  gap: "competitor gap",
  expansion: "paid expansion",
  autocomplete: "autocomplete",
  harvest: "harvested question",
  manual: "added by hand",
};

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** The row a proposal INSERT is built from — everything the queue needs to
 *  explain itself, computed once here rather than re-derived on read. */
type NetNewProposalDraft = {
  target: string;
  title: string;
  pageTypeId: string;
  keywordBacklogId: string;
  score: number;
  factors: ProposalFactor[];
  evidence: string[];
};

export function buildNetNewProposal(pick: NetNewPick): NetNewProposalDraft {
  return {
    target: pick.keyword,
    title: renderTitle(pick.keyword),
    pageTypeId: pick.pageTypeId,
    keywordBacklogId: pick.backlogId,
    score: pick.score,
    factors: [
      {
        name: "Score",
        value: pick.score,
        note: "log-volume × inverse-difficulty × intent, from the engine's scorer",
      },
      volumeFactor(pick),
      difficultyFactor(pick),
      slotFactor(pick.slot),
    ],
    evidence: [
      pick.pageTypeName,
      SOURCE_LABEL[pick.source],
      ...(pick.impressions28 === null
        ? []
        : [`${fmtInt(pick.impressions28)} impressions over 28 days`]),
      ...(pick.slot === "pool" ? ["fresh question"] : []),
    ],
  };
}

function volumeFactor(pick: NetNewCandidate): ProposalFactor {
  if (pick.searchVolume !== null) {
    return {
      name: "Volume",
      value: fmtInt(pick.searchVolume),
      note: "monthly searches, as priced by the metrics provider",
    };
  }
  if (pick.impressions28 !== null) {
    return {
      name: "Volume",
      value: fmtInt(pick.impressions28),
      note: "imputed from 28 days of Search Console impressions — no vendor price",
    };
  }
  return {
    name: "Volume",
    value: "not priced",
    note: "a free-source long-tail row; the score treats it as zero volume, not as a zero score",
  };
}

function difficultyFactor(pick: NetNewCandidate): ProposalFactor {
  return pick.keywordDifficulty === null
    ? {
        name: "Difficulty",
        value: "unmeasured",
        note: "nothing priced a difficulty for this keyword; the score assumes 50",
      }
    : {
        name: "Difficulty",
        value: pick.keywordDifficulty,
        note: "provider estimate, 0-100",
      };
}

/** The pool-slot marker. It rides in the factors rather than only in a chip
 *  because it is the answer to "why is this low-scoring row in my batch?" —
 *  the rule is meant to be visible, not inferred. */
function slotFactor(slot: Slot): ProposalFactor {
  return slot === "pool"
    ? {
        name: "Slot",
        value: "fresh question",
        note: "one slot per batch goes to a harvested question, replacing the weakest scored pick",
      }
    : {
        name: "Slot",
        value: "scored",
        note: "ranked into the batch on score",
      };
}

// ---------------------------------------------------------------------------
// The daily block's due set
// ---------------------------------------------------------------------------

/** Per-project net-new state, as one grouped read gives it. */
type NetNewProjectStat = {
  projectId: string;
  outstanding: number;
  /** Newest net-new proposal's createdAt — this project's last-run stamp.
   *  Null when the project has never had one. */
  lastProposedAt: string | null;
};

/**
 * Which projects the daily block should compute, oldest stamp first.
 *
 * Two skips, both cheap enough to make in memory and both saving a whole
 * compute: a project with the quota off has opted out of the schedule
 * entirely, and a project already holding `catchupCap` net-new proposals is
 * at the arithmetic ceiling — `owed` can never exceed the cap, so the run
 * would produce nothing however the quota came out.
 *
 * The stamp ordering is what keeps a 15-minute tick fair once the cap binds:
 * every project that gets served sorts to the back of the queue.
 */
export function dueProjectsForNetNew(input: {
  settings: (QuotaSettings & { projectId: string })[];
  stats: NetNewProjectStat[];
  /** ISO timestamp; a project proposed at or after this has had its turn. */
  cutoff: string;
  limit: number;
}): string[] {
  const statByProject = new Map(input.stats.map((s) => [s.projectId, s]));
  const due: { projectId: string; lastProposedAt: string | null }[] = [];
  for (const setting of input.settings) {
    if (setting.quotaStartDate === null) continue;
    const stat = statByProject.get(setting.projectId);
    const outstanding = stat?.outstanding ?? 0;
    if (outstanding >= setting.catchupCap) continue;
    const lastProposedAt = stat?.lastProposedAt ?? null;
    if (lastProposedAt !== null && lastProposedAt >= input.cutoff) continue;
    due.push({ projectId: setting.projectId, lastProposedAt });
  }
  return due
    .toSorted(
      (a, b) =>
        (a.lastProposedAt ?? "").localeCompare(b.lastProposedAt ?? "") ||
        a.projectId.localeCompare(b.projectId),
    )
    .slice(0, input.limit)
    .map((row) => row.projectId);
}
