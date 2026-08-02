import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  backlinkSnapshots,
  outreachTargets,
  projects,
  submissionKits,
} from "@/db/schema";
import {
  classifyTarget,
  rankTargets,
  targetKey,
  type ArmoryCandidate,
} from "@/server/features/rankloop/outreach/armory.logic";
import {
  statusAfterVerify,
  verdictFor,
} from "@/server/features/rankloop/outreach/linkVerify.logic";
import { kitGaps, renderPayload, type SubmissionKit } from "@/shared/submission-kit";
import seedPack from "@/server/features/rankloop/outreach/data/seed-targets.json";
import { AppError } from "@/server/lib/errors";

// The Grow armory (spec 0029).
//
// Seeding is free — it reads a shipped data file and writes rows. SERP
// mining bills per call and lives behind an explicit action elsewhere; this
// service never spends money.

// The shipped pack, parsed once at module load. If a bad edit ever lands in
// the JSON we want it to fail here rather than render a board of undefineds.
const seedPackSchema = z.object({
  checkedAt: z.string(),
  targets: z.array(
    z.object({
      domain: z.string(),
      name: z.string(),
      kind: z.string(),
      submissionUrl: z.string(),
      pricing: z.string(),
      mode: z.string(),
      audience: z.string(),
      check: z.object({
        at: z.string(),
        status: z.number(),
        urlConfirmed: z.boolean(),
        note: z.string().optional(),
      }),
    }),
  ),
});

const SEED_PACK = seedPackSchema.parse(seedPack);
const SEED_TARGETS = SEED_PACK.targets;
const SEED_CHECKED_AT = SEED_PACK.checkedAt;

/**
 * Add the curated pack to a project's board.
 *
 * Idempotent by the existing (project, domain) unique index: seeding twice
 * updates rather than duplicating, and a domain already on the board from
 * the link gap keeps its competitor evidence while gaining a submission URL.
 */
async function seedBoard(projectId: string): Promise<{ added: number }> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ domain: outreachTargets.domain })
    .from(outreachTargets)
    .where(eq(outreachTargets.projectId, projectId));
  const known = new Set(existing.map((row) => targetKey(row.domain)));

  const rows = SEED_TARGETS.map((target) => ({
    id: crypto.randomUUID(),
    projectId,
    domain: target.domain,
    lane: "seed" as const,
    kind: kindOf(target),
    submissionUrl: target.submissionUrl,
    domainRank: null,
    competitorCount: 0,
    // The evidence IS the verification record: what we checked and when. A
    // seed row that cannot say when it was last confirmed is a claim with no
    // date on it.
    evidenceJson: JSON.stringify({
      seed: {
        name: target.name,
        pricing: target.pricing,
        mode: target.mode,
        checkedAt: target.check.at,
        urlConfirmed: target.check.urlConfirmed,
        ...(target.check.note ? { note: target.check.note } : {}),
      },
    }),
    createdAt: now,
    updatedAt: now,
  }));

  for (const row of rows) {
    await db
      .insert(outreachTargets)
      .values(row)
      .onConflictDoUpdate({
        target: [outreachTargets.projectId, outreachTargets.domain],
        set: {
          // Only the facts the seed pack owns. Status, notes and any draft
          // belong to the human and are never touched by a reseed.
          submissionUrl: row.submissionUrl,
          kind: row.kind,
          updatedAt: now,
        },
      });
  }

  return { added: rows.filter((r) => !known.has(targetKey(r.domain))).length };
}

function kindOf(target: (typeof SEED_TARGETS)[number]): "directory" | "listicle" | "blog" | "resource_page" {
  if (target.kind === "listicle") return "listicle";
  if (target.kind === "community") return "resource_page";
  return classifyTarget(target.submissionUrl);
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

export interface ArmoryRow extends ArmoryCandidate {
  id: string;
  status: string;
  score: number;
  why: string;
  linkLiveAt: string | null;
  lastCheckedAt: string | null;
  verifiedUrl: string | null;
  seedName: string | null;
  seedCheckedAt: string | null;
  seedUrlConfirmed: boolean | null;
}

async function getBoard(projectId: string): Promise<{
  rows: ArmoryRow[];
  seedCheckedAt: string;
  kit: SubmissionKit | null;
  /** What to prefill an empty kit with. A blank form asking for a product
   *  name when the project already has one is busywork we can do ourselves. */
  kitDefaults: { name: string; url: string };
  kitGaps: string[];
}> {
  const [targets, kit, project] = await Promise.all([
    db.select().from(outreachTargets).where(eq(outreachTargets.projectId, projectId)),
    getKit(projectId),
    db
      .select({ name: projects.name, domain: projects.domain })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
  ]);

  const candidates: (ArmoryCandidate & { row: (typeof targets)[number] })[] =
    targets.map((row) => {
      const evidence = parseEvidence(row.evidenceJson);
      return {
        row,
        domain: row.domain,
        lane: (row.lane ?? "link_gap") as ArmoryCandidate["lane"],
        kind: (row.kind ?? "resource_page") as ArmoryCandidate["kind"],
        submissionUrl: row.submissionUrl,
        domainRank: row.domainRank,
        competitorCount: row.competitorCount,
        evidence: evidence.seed?.name ?? `links to ${row.competitorCount} of your competitors`,
      };
    });

  // The project's own rank, so attainability can tell "reachable" from "out
  // of league" instead of sorting the least winnable rows to the top.
  const ranked = rankTargets(candidates, await ourDomainRank(projectId));
  const byDomain = new Map(candidates.map((c) => [targetKey(c.domain), c.row]));

  const rows: ArmoryRow[] = ranked.map((scored) => {
    const row = byDomain.get(targetKey(scored.domain))!;
    const evidence = parseEvidence(row.evidenceJson);
    return {
      ...scored,
      id: row.id,
      status: row.status,
      linkLiveAt: row.linkLiveAt,
      lastCheckedAt: row.lastCheckedAt,
      verifiedUrl: row.verifiedUrl,
      seedName: evidence.seed?.name ?? null,
      seedCheckedAt: evidence.seed?.checkedAt ?? null,
      seedUrlConfirmed: evidence.seed?.urlConfirmed ?? null,
    };
  });

  const domain = project[0]?.domain ?? "";
  return {
    rows,
    seedCheckedAt: SEED_CHECKED_AT,
    kit,
    kitDefaults: {
      name: project[0]?.name ?? domain,
      url: domain ? (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : "",
    },
    kitGaps: kitGaps(kit ?? {}),
  };
}

/**
 * The seed half of the stored evidence blob.
 *
 * `evidenceJson` is written by whichever release created the row and holds
 * two different shapes — the link gap's per-competitor evidence and the seed
 * pack's verification record. Asserting a type over it compiles and then
 * reads `undefined.name` on the other shape, so it is parsed, the same way
 * the stored AI-access probe is.
 */
const storedEvidenceSchema = z.object({
  seed: z
    .object({
      name: z.string(),
      checkedAt: z.string().default(""),
      urlConfirmed: z.boolean().default(false),
    })
    .optional(),
});

type StoredEvidence = z.infer<typeof storedEvidenceSchema>;

function parseEvidence(json: string | null): StoredEvidence {
  if (!json) return {};
  try {
    const parsed = storedEvidenceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Our own domain rank, for the attainability comparison.
 *
 * Read from the stored backlink snapshot rather than fetched: attainability
 * is a sort hint, and spending a metered backlinks call every time the board
 * renders would be a bill for a nicer ordering. Null when no snapshot exists
 * yet, which `attainability` handles by simply not applying the out-of-league
 * penalty — an unknown gap is not evidence of a large one.
 */
async function ourDomainRank(projectId: string): Promise<number | null> {
  const [snapshot] = await db
    .select({ rank: backlinkSnapshots.rank })
    .from(backlinkSnapshots)
    .where(eq(backlinkSnapshots.projectId, projectId))
    .orderBy(desc(backlinkSnapshots.capturedAt))
    .limit(1);
  return snapshot?.rank ?? null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const VERIFY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Re-fetch each waiting target and record the links that went live.
 *
 * The only transition rankloop makes on this board. `not_found` and
 * `unreachable` update `lastCheckedAt` and nothing else — an absent link is
 * never written as a rejection.
 */
async function verifyLinks(
  projectId: string,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis),
  limit = 25,
): Promise<{ checked: number; nowLive: number }> {
  const [project] = await db
    .select({ domain: projects.domain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.domain) throw new AppError("NOT_FOUND", "Project has no domain");

  const waiting = await db
    .select()
    .from(outreachTargets)
    .where(
      and(
        eq(outreachTargets.projectId, projectId),
        inArray(outreachTargets.status, ["to_contact", "sent", "replied"]),
        // Only rows with somewhere to look. A target with no submission URL
        // and no contact page has no page to check.
        or(
          isNotNull(outreachTargets.submissionUrl),
          isNotNull(outreachTargets.contactUrl),
        ),
      ),
    )
    .limit(limit);

  const now = new Date().toISOString();
  let nowLive = 0;

  for (const row of waiting) {
    const url = row.submissionUrl ?? row.contactUrl;
    if (!url) continue;

    const fetched = await fetchPage(url, fetchImpl);
    const verdict = verdictFor({ ...fetched, domain: project.domain });
    const next = statusAfterVerify({ current: row.status, verdict });

    if (next && verdict.state === "live") {
      nowLive++;
      await db
        .update(outreachTargets)
        .set({
          status: "linked",
          linkLiveAt: row.linkLiveAt ?? now,
          lastCheckedAt: now,
          verifiedUrl: verdict.links[0]?.href ?? url,
          updatedAt: now,
        })
        .where(eq(outreachTargets.id, row.id));
    } else {
      await db
        .update(outreachTargets)
        .set({ lastCheckedAt: now })
        .where(eq(outreachTargets.id, row.id));
    }
  }

  return { checked: waiting.length, nowLive };
}

async function fetchPage(
  url: string,
  fetchImpl: FetchImpl,
): Promise<{ status: number | null; html: string | null }> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": VERIFY_UA },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, html: await res.text() };
  } catch {
    return { status: null, html: null };
  }
}

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

async function getKit(projectId: string): Promise<SubmissionKit | null> {
  const [row] = await db
    .select()
    .from(submissionKits)
    .where(eq(submissionKits.projectId, projectId))
    .limit(1);
  if (!row) return null;

  let categories: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.categoriesJson);
    if (Array.isArray(parsed)) {
      categories = parsed.filter((c): c is string => typeof c === "string");
    }
  } catch {
    /* a malformed list is no list, not a crash */
  }

  return {
    name: row.name,
    tagline: row.tagline,
    shortDescription: row.shortDescription,
    longDescription: row.longDescription,
    url: row.url,
    logoUrl: row.logoUrl,
    categories,
    pricing: row.pricing,
    founder: row.founder,
    launchDate: row.launchDate,
  };
}

async function saveKit(
  projectId: string,
  kit: SubmissionKit,
): Promise<SubmissionKit> {
  const now = new Date().toISOString();
  await db
    .insert(submissionKits)
    .values({
      id: crypto.randomUUID(),
      projectId,
      name: kit.name,
      tagline: kit.tagline,
      shortDescription: kit.shortDescription,
      longDescription: kit.longDescription,
      url: kit.url,
      logoUrl: kit.logoUrl,
      categoriesJson: JSON.stringify(kit.categories),
      pricing: kit.pricing,
      founder: kit.founder,
      launchDate: kit.launchDate,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [submissionKits.projectId],
      set: {
        name: kit.name,
        tagline: kit.tagline,
        shortDescription: kit.shortDescription,
        longDescription: kit.longDescription,
        url: kit.url,
        logoUrl: kit.logoUrl,
        categoriesJson: JSON.stringify(kit.categories),
        pricing: kit.pricing,
        founder: kit.founder,
        launchDate: kit.launchDate,
        updatedAt: now,
      },
    });
  return kit;
}

/** The copy-ready payload for one target. */
async function getPayload(projectId: string, targetId: string) {
  const kit = await getKit(projectId);
  if (!kit) return { fields: [], gaps: kitGaps({}) };
  const [target] = await db
    .select()
    .from(outreachTargets)
    .where(
      and(eq(outreachTargets.id, targetId), eq(outreachTargets.projectId, projectId)),
    )
    .limit(1);
  return {
    fields: renderPayload(kit),
    gaps: kitGaps(kit),
    submissionUrl: target?.submissionUrl ?? null,
  };
}

export const ArmoryService = {
  seedBoard,
  getBoard,
  verifyLinks,
  getKit,
  saveKit,
  getPayload,
};
