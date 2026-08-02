// The pipeline stage model (spec 0028) — one answer to "what has run, what
// is running, what is blocked, and what needs a human".
//
// Three surfaces read this: the Today spine, the sequence gate on every
// screen, and the Day-0 cascade orchestrator that decides what to start
// next. Before this existed, the spine computed its own state inline across
// five hooks in JSX — which is why nothing else could reuse it and why
// nothing ever auto-advanced.
//
// Pure. No I/O, no queries. `PipelineService` gathers the facts; this file
// decides what they mean.

export type RunStatus = "pending" | "running" | "done" | "error";

export type StageId =
  | "site"
  | "access"
  | "memory"
  | "market"
  | "keywords"
  | "plan"
  | "titles"
  | "publish";

/**
 * The distinction the whole UX turns on is `waiting` vs `needs_you`.
 *
 * Today both render as an inert grey row, so a user cannot tell "rankloop is
 * getting to it" from "rankloop is stuck on you". Only `needs_you` may enter
 * the needs-you queue, and only `needs_you` may block a screen with a call
 * to action.
 */
export type StageStatus =
  | "done"
  | "running"
  | "error"
  | "waiting"
  | "needs_you"
  | "idle";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  /** One plain sentence. What a user reads on the spine. */
  detail: string;
  /** For `waiting`: the stage we are waiting on. For `needs_you`: what the
   *  user has to do. Null otherwise. */
  blockedBy: string | null;
  /** Present only on `needs_you` — the single button that unblocks it. */
  action: { label: string; to: string } | null;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface PipelineFacts {
  siteStudy: {
    status: RunStatus | null;
    pages: number;
    posts: number;
    /** Live crawl progress while running. */
    crawled: number;
    total: number;
  };
  aiAccess: { checked: boolean; blockedAgents: number; findings: number };
  gsc: {
    /** False when the deployment has no Google OAuth client configured —
     *  a different problem from the user not having connected, and one the
     *  user cannot fix from the UI. */
    oauthConfigured: boolean;
    connected: boolean;
    status: RunStatus | null;
    dayCount: number;
  };
  competitors: {
    tracked: number;
    studied: number;
    running: boolean;
    anyError: boolean;
  };
  keywords: { status: RunStatus | null; backlog: number };
  plan: {
    status: RunStatus | null;
    proposed: number;
    approved: number;
  };
  titles: { proposed: number; approved: number };
  publish: { configured: boolean; published: number };
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

/** What each stage needs before it can run at all. `site` and `access` need
 *  nothing, which is what lets day 0 start the moment a domain is entered. */
const PREREQUISITES: Record<StageId, StageId[]> = {
  site: [],
  access: [],
  memory: [],
  market: ["site"],
  keywords: ["site"],
  plan: ["keywords"],
  titles: ["plan"],
  publish: ["titles"],
};

const LABELS: Record<StageId, string> = {
  site: "Your site",
  access: "AI access",
  memory: "Search memory",
  market: "Your market",
  keywords: "Keywords",
  plan: "Your plan",
  titles: "Titles",
  publish: "Published",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Lowercase a leading word unless it is a proper noun we know about —
 *  "Search Console not connected" must not become "search console". */
function lowerFirst(text: string): string {
  if (/^(Search Console|Google|Your)\b/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Per-stage reading
// ---------------------------------------------------------------------------

/** Everything a stage can say about itself, before prerequisites are
 *  applied. Returning `null` for status means "nothing has started this". */
type Reading = {
  status: Exclude<StageStatus, "waiting">;
  detail: string;
  blockedBy?: string | null;
  action?: { label: string; to: string } | null;
};

function readSite(f: PipelineFacts): Reading {
  const s = f.siteStudy;
  if (s.status === "pending" || s.status === "running") {
    return {
      status: "running",
      detail:
        s.total > 0
          ? `Crawling ${s.crawled.toLocaleString()} of ${s.total.toLocaleString()} pages`
          : "Crawling your site",
    };
  }
  if (s.status === "error") {
    return { status: "error", detail: "The last crawl failed" };
  }
  if (s.status === "done" || s.pages > 0) {
    return {
      status: "done",
      detail: `${plural(s.pages, "page")}, ${plural(s.posts, "post")}`,
    };
  }
  return { status: "idle", detail: "Not crawled yet" };
}

function readAccess(f: PipelineFacts): Reading {
  const a = f.aiAccess;
  if (!a.checked) return { status: "idle", detail: "Not checked yet" };
  if (a.blockedAgents > 0) {
    return {
      status: "done",
      detail: `${plural(a.blockedAgents, "AI crawler")} blocked`,
    };
  }
  return {
    status: "done",
    detail:
      a.findings > 0
        ? `All AI crawlers allowed, ${plural(a.findings, "suggestion")}`
        : "All AI crawlers allowed",
  };
}

function readMemory(f: PipelineFacts): Reading {
  const g = f.gsc;
  // A deployment with no OAuth client is not the user failing to connect —
  // it is a deployment the user usually cannot fix from this screen. Saying
  // "connect Search Console" would send them to a button that cannot work.
  if (!g.oauthConfigured) {
    return {
      status: "needs_you",
      detail: "This deployment has no Google OAuth client configured",
      blockedBy: "Google OAuth client not configured",
      action: { label: "Open setup guide", to: "/p/$projectId/connect" },
    };
  }
  if (!g.connected) {
    return {
      status: "needs_you",
      detail: "Without it rankloop cannot see your real search queries",
      blockedBy: "Search Console not connected",
      action: { label: "Connect Search Console", to: "/p/$projectId/connect" },
    };
  }
  if (g.status === "pending" || g.status === "running") {
    return {
      status: "running",
      detail:
        g.dayCount > 0
          ? `Syncing, ${plural(g.dayCount, "day")} stored`
          : "Syncing your search history",
    };
  }
  if (g.status === "error") {
    return { status: "error", detail: "The last sync failed" };
  }
  if (g.dayCount > 0) {
    return { status: "done", detail: `${plural(g.dayCount, "day")} stored` };
  }
  return { status: "idle", detail: "Connected, not synced yet" };
}

function readMarket(f: PipelineFacts): Reading {
  const c = f.competitors;
  if (c.running) {
    return {
      status: "running",
      detail: `Studying ${plural(c.tracked, "competitor")}`,
    };
  }
  if (c.tracked > 0) {
    const detail = `${plural(c.tracked, "competitor")}, ${c.studied} studied`;
    // A failed study keeps the counts: with three tracked competitors,
    // "a study failed" alone would hide the two that worked.
    return {
      status: c.anyError && c.studied === 0 ? "error" : "done",
      detail: c.anyError ? `${detail} · a study failed` : detail,
    };
  }
  return { status: "idle", detail: "No competitors found yet" };
}

function readKeywords(f: PipelineFacts): Reading {
  const k = f.keywords;
  if (k.status === "pending" || k.status === "running") {
    return {
      status: "running",
      detail:
        k.backlog > 0
          ? `Gathering, ${plural(k.backlog, "keyword")} so far`
          : "Gathering keywords",
    };
  }
  if (k.backlog > 0) {
    return { status: "done", detail: `${plural(k.backlog, "keyword")} found` };
  }
  if (k.status === "error") {
    return { status: "error", detail: "The last run failed" };
  }
  return { status: "idle", detail: "Nothing gathered yet" };
}

function readPlan(f: PipelineFacts): Reading {
  const p = f.plan;
  if (p.status === "pending" || p.status === "running") {
    return { status: "running", detail: "Working out what to build" };
  }
  // Gate 1. Approved types are what everything downstream binds to, so a
  // plan with proposals and no approvals is waiting on a person, not on us.
  if (p.approved > 0) {
    return {
      status: "done",
      detail: `${plural(p.approved, "page type")} approved`,
    };
  }
  if (p.proposed > 0) {
    return {
      status: "needs_you",
      detail: `${plural(p.proposed, "page type")} proposed, none approved yet`,
      blockedBy: "Your approval",
      action: { label: "Review the plan", to: "/p/$projectId/plan" },
    };
  }
  if (p.status === "error") {
    return { status: "error", detail: "The last run failed" };
  }
  return { status: "idle", detail: "Not planned yet" };
}

function readTitles(f: PipelineFacts): Reading {
  const t = f.titles;
  if (t.approved > 0) {
    return { status: "done", detail: `${plural(t.approved, "title")} approved` };
  }
  if (t.proposed > 0) {
    return {
      status: "needs_you",
      detail: `${plural(t.proposed, "title")} waiting on you`,
      blockedBy: "Your approval",
      action: { label: "Review titles", to: "/p/$projectId/articles" },
    };
  }
  return { status: "idle", detail: "None proposed yet" };
}

function readPublish(f: PipelineFacts): Reading {
  const p = f.publish;
  if (p.published > 0) {
    return { status: "done", detail: `${plural(p.published, "article")} live` };
  }
  // Copy-paste is always available, so "no destination" is a choice not yet
  // made rather than a capability the user lacks.
  if (!p.configured) {
    return {
      status: "needs_you",
      detail: "Choose where posts should go — a repo, a CMS, or copy-paste",
      blockedBy: "No destination chosen",
      action: { label: "Choose a destination", to: "/p/$projectId/connect" },
    };
  }
  return { status: "idle", detail: "Nothing published yet" };
}

const READERS: Record<StageId, (f: PipelineFacts) => Reading> = {
  site: readSite,
  access: readAccess,
  memory: readMemory,
  market: readMarket,
  keywords: readKeywords,
  plan: readPlan,
  titles: readTitles,
  publish: readPublish,
};

export const STAGE_ORDER: StageId[] = [
  "site",
  "access",
  "memory",
  "market",
  "keywords",
  "plan",
  "titles",
  "publish",
];

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface Pipeline {
  stages: Stage[];
  /** Everything a human has to act on, in stage order. The Today queue. */
  needsYou: Stage[];
  /** True while any stage is in flight — what the spine polls on. */
  busy: boolean;
  /** True once the cascade has nothing left it can start on its own. */
  settled: boolean;
}

export function buildPipeline(facts: PipelineFacts): Pipeline {
  const byId = new Map<StageId, Stage>();

  for (const id of STAGE_ORDER) {
    const reading = READERS[id](facts);

    // A stage that has already produced output keeps its reading even if a
    // prerequisite looks unfinished. Prerequisites describe what has to
    // happen FIRST, not what has to stay true — a re-crawl in flight must
    // not blank out the keyword count underneath it.
    const settledAlready =
      reading.status === "done" ||
      reading.status === "running" ||
      reading.status === "error" ||
      reading.status === "needs_you";

    if (!settledAlready) {
      const unmet = PREREQUISITES[id].find(
        (prereq) => byId.get(prereq)?.status !== "done",
      );
      if (unmet !== undefined) {
        byId.set(id, {
          id,
          label: LABELS[id],
          status: "waiting",
          detail: `Waiting for ${LABELS[unmet].toLowerCase()}`,
          blockedBy: LABELS[unmet],
          action: null,
        });
        continue;
      }
    }

    byId.set(id, {
      id,
      label: LABELS[id],
      status: reading.status,
      detail: reading.detail,
      blockedBy: reading.blockedBy ?? null,
      action: reading.action ?? null,
    });
  }

  const stages = STAGE_ORDER.map((id) => byId.get(id)!);
  return {
    stages,
    needsYou: stages.filter((s) => s.status === "needs_you"),
    busy: stages.some((s) => s.status === "running"),
    settled: startableStages(stages).length === 0 && !stages.some((s) => s.status === "running"),
  };
}

/**
 * What the cascade should start right now.
 *
 * The orchestrator's whole rule: every stage that is `idle` and whose
 * prerequisites are `done`. Deriving it from the same model the UI reads is
 * the point — a second definition of "what comes next" would drift from the
 * one users can see.
 *
 * `needs_you` stages are deliberately not startable and deliberately do not
 * block anything downstream of them. That is what makes Search Console a
 * prompt rather than a gate: a project without it still studies its site,
 * finds competitors, builds a universe and drafts a plan.
 */
export function startableStages(stages: readonly Stage[]): StageId[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  return stages
    .filter((s) => s.status === "idle")
    .filter((s) =>
      PREREQUISITES[s.id].every((p) => byId.get(p)?.status === "done"),
    )
    .map((s) => s.id);
}

/** The one line the Today screen leads with. */
export function pipelineHeadline(pipeline: Pipeline): string {
  const running = pipeline.stages.filter((s) => s.status === "running");
  if (running.length > 0) {
    return running.map((s) => s.detail).join(" · ");
  }
  if (pipeline.needsYou.length === 1) {
    return pipeline.needsYou[0].detail;
  }
  if (pipeline.needsYou.length > 1) {
    // With several outstanding, the first stage's detail sentence stops
    // being a headline and starts being one item read out of context. Name
    // what is blocked instead and let the queue below carry the detail.
    const blockers = pipeline.needsYou.map((s) =>
      lowerFirst(s.blockedBy ?? s.label),
    );
    return `${pipeline.needsYou.length} things need you: ${blockers.join(", ")}`;
  }
  const errored = pipeline.stages.filter((s) => s.status === "error");
  if (errored.length > 0) {
    return `${errored[0].label} failed on its last run`;
  }
  return "Everything is running on its own";
}
