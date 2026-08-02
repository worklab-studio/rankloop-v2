import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { aiAccessSnapshots, contentPages, pageTypes, projects } from "@/db/schema";
import type { AiAccessProbe } from "@/server/features/rankloop/verdict/aiAccess";

export type AiAccessSnapshotRow = typeof aiAccessSnapshots.$inferSelect;

/**
 * Where the site lives, as far as the probe is concerned.
 *
 * `blogPath` comes from an approved page type's URL pattern when there is
 * one, because that is the path rankloop will actually publish to, and the
 * AI access card checks it separately from the site root. Falling back to
 * "blog" matches the engine's own default.
 */
async function getProjectSite(projectId: string): Promise<{
  name: string;
  domain: string;
  blogPath: string;
} | null> {
  const [project] = await db
    .select({ name: projects.name, domain: projects.domain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  // A project with no domain has nothing to probe. Treated the same as a
  // missing project so the caller has one "there is no site here" branch
  // rather than two.
  if (!project?.domain) return null;

  const [pattern] = await db
    .select({ urlPattern: pageTypes.urlPattern })
    .from(pageTypes)
    .where(
      and(eq(pageTypes.projectId, projectId), isNotNull(pageTypes.urlPattern)),
    )
    .limit(1);

  return {
    // A project can be unnamed; the domain is the honest fallback and is what
    // the generated llms.txt will carry as its heading.
    name: project.name ?? project.domain,
    domain: project.domain,
    blogPath: blogRootOf(pattern?.urlPattern ?? null),
  };
}

/**
 * Pages for the generated llms.txt.
 *
 * Capped: llms.txt is a map, not an archive, and a 40,000-line file helps
 * nobody. Sites past the cap get the most recently crawled pages, which is
 * the closest thing to "most relevant" available without ranking data.
 */
async function getCorpusForLlmsTxt(
  projectId: string,
  limit = 500,
): Promise<{ url: string; title: string | null; description: string | null }[]> {
  return db
    .select({
      url: contentPages.url,
      title: contentPages.title,
      description: contentPages.description,
    })
    .from(contentPages)
    .where(eq(contentPages.projectId, projectId))
    .orderBy(desc(contentPages.lastCrawledAt))
    .limit(limit);
}

/** "/compare/{slug}/" hangs off "compare". A pattern with no fixed segment
 *  falls back to "blog" — the same rule PublishLinksService uses, so the
 *  card checks the path the publisher will actually write to. */
export function blogRootOf(urlPattern: string | null): string {
  const segment = (urlPattern ?? "")
    .split("/")
    .find((part) => part !== "" && !part.includes("{"));
  return segment ?? "blog";
}

async function insertSnapshot(input: {
  projectId: string;
  probe: AiAccessProbe;
}): Promise<{ id: string; createdAt: string }> {
  const { probe } = input;
  const row = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    // Stamped here rather than left to the column default. The default would
    // be correct in the database and absent from this object, so the caller
    // would read `undefined` as the time of a probe that just ran.
    createdAt: new Date().toISOString(),
    canonicalOrigin: probe.canonicalOrigin,
    redirected: probe.redirected,
    reachable: probe.reachable,
    robotsState: probe.robots.state,
    robotsText: probe.robots.state === "ok" ? probe.robots.text : null,
    blockedAgents: probe.agents.filter((a) => a.blocked).length,
    llmsTxtPresent:
      probe.llmsFiles.find((f) => f.path === "/llms.txt")?.present ?? false,
    llmsFullPresent:
      probe.llmsFiles.find((f) => f.path === "/llms-full.txt")?.present ?? false,
    edgeBlocked: probe.edge.some((e) => e.blocked),
    htmlWords: probe.jsGating?.words ?? null,
    payload: probe,
  };
  await db.insert(aiAccessSnapshots).values(row);
  return { id: row.id, createdAt: row.createdAt };
}

async function latestSnapshot(
  projectId: string,
): Promise<AiAccessSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(aiAccessSnapshots)
    .where(eq(aiAccessSnapshots.projectId, projectId))
    .orderBy(desc(aiAccessSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

export const VerdictRepository = {
  getProjectSite,
  getCorpusForLlmsTxt,
  insertSnapshot,
  latestSnapshot,
};
