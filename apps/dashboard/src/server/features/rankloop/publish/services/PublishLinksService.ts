import { defaultLaws, llmsFull, llmsTxt, rss, sitemap } from "@rankloop/engine";
import type { EngineConfig, Post } from "@rankloop/engine";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import { resolvePublishAdapter } from "@/server/features/rankloop/publish/adapters/resolve";
import type {
  DerivedArtifact,
  PublishAdapter,
} from "@/server/features/rankloop/publish/adapters/types";
import {
  pickLinkTargets,
  type LinkTarget,
} from "@/server/features/rankloop/publish/linkTargets.logic";
import { mergeRelatedBlock } from "@/server/features/rankloop/publish/relatedBlock.logic";
import { PublishRepository } from "@/server/features/rankloop/publish/repositories/PublishRepository";
import type { PublishContext } from "@/server/features/rankloop/publish/services/publishContext";
import type { RankloopInjectedLink } from "@/types/schemas/rankloopPublish";

// Steps 5 and 6 of the publish workflow: the contextual links, and the derived
// artifacts that only one target owns.
//
// This is the file that edits pages rankloop did not create, so it is the file
// rule 2 is about. Every write here goes through `mergeRelatedBlock` and
// nothing else touches an existing page's bytes — which is what makes the
// spec's grep proof a one-line grep.

// ---------------------------------------------------------------------------
// Step 5 — the owned block in up to three neighbours
// ---------------------------------------------------------------------------

/**
 * Choose the neighbours before the post exists, so the same list can ride in a
 * delegated target's create payload and be applied by an editing target
 * afterwards. Selection is pure and deterministic, so both readings agree.
 */
async function planLinks(context: PublishContext): Promise<LinkTarget[]> {
  const [candidates, hubContentPageId] = await Promise.all([
    PublishRepository.getLinkCandidates(context.projectId),
    hubIdFor(context),
  ]);
  return pickLinkTargets({
    candidates,
    pageTypeId: context.pageTypeId,
    keyword: context.keyword,
    selfPath: context.path,
    hubContentPageId,
  });
}

async function hubIdFor(context: PublishContext): Promise<string | null> {
  if (!context.pageTypeId) return null;
  const pageType = await PagePlanRepository.getPageTypeById(
    context.projectId,
    context.pageTypeId,
  );
  return pageType?.hubContentPageId ?? null;
}

/**
 * Maintain rankloop's owned block in each chosen neighbour.
 *
 * Every page is read first and written back whole: the merge splices between
 * the delimiters and copies everything else through byte for byte, so a page
 * that already carries the link comes back `===` what the target returned and
 * is never written at all. That last part matters more than it sounds — a
 * no-op write is still a revision in somebody's CMS history, still a commit in
 * somebody's repository, and still a modified date search engines will notice.
 *
 * Nothing here is fatal. The article is published by the time this runs, and a
 * neighbour that could not be edited is a weaker publish, not a failed one, so
 * each outcome is recorded and the run continues.
 */
async function injectLinks(input: {
  context: PublishContext;
  targets: LinkTarget[];
  /** The anchor text neighbours will link with — the published title. */
  anchor: string;
}): Promise<{ links: RankloopInjectedLink[] }> {
  const { context, targets } = input;
  if (targets.length === 0) return { links: [] };

  const resolved = await resolvePublishAdapter(context.projectId, {
    slug: context.slug,
  });
  if (!resolved) return { links: [] };
  if (!resolved.settings.linkInjection) return { links: [] };

  // A delegated target was already told the whole list inside createPost, so
  // re-sending it here would be a second request asking for the same edit.
  if (resolved.adapter.capabilities.linkInjection === "delegated") {
    return {
      links: targets.map((target) => ({
        contentPageId: target.contentPageId,
        path: target.path,
        outcome: "delegated" as const,
      })),
    };
  }

  const format = resolved.adapter.capabilities.contentFormat;
  const links: RankloopInjectedLink[] = [];
  for (const target of targets) {
    links.push(
      await injectOne({
        adapter: resolved.adapter,
        target,
        format,
        link: { path: context.path, title: input.anchor },
      }),
    );
  }
  return { links };
}

async function injectOne(input: {
  adapter: PublishAdapter;
  target: LinkTarget;
  format: "html" | "markdown";
  link: { path: string; title: string };
}): Promise<RankloopInjectedLink> {
  const record = (outcome: RankloopInjectedLink["outcome"]) => ({
    contentPageId: input.target.contentPageId,
    path: input.target.path,
    outcome,
  });
  try {
    const page = await input.adapter.getPost(input.target.path);
    if (!page) return record("missing");

    const merged = mergeRelatedBlock({
      content: page.body,
      links: [input.link],
      format: input.format,
    });
    if (merged.outcome === "malformed") return record("malformed");
    if (merged.content === page.body) return record("unchanged");

    await input.adapter.updatePost({
      ref: page.ref,
      path: page.path,
      body: merged.content,
    });
    return record("injected");
  } catch (error) {
    console.info(
      `[rankloop-publish] could not inject into ${input.target.path}:`,
      error instanceof Error ? error.message : error,
    );
    return record("failed");
  }
}

// ---------------------------------------------------------------------------
// Step 6 — the derived artifacts, on the one target that owns them
// ---------------------------------------------------------------------------

/**
 * Regenerate sitemap.xml, rss.xml, llms.txt and llms-full.txt from the
 * manifest and commit them with the post that changed them.
 *
 * Only where `ownsDerivedArtifacts` says these files are ours. On WordPress
 * and webhook targets the user's own stack generates them, and rewriting
 * somebody's sitemap because we happened to add a page to it is the same
 * trespass rule 2 forbids one level down. The engine regenerates each file
 * whole, so this is idempotent by construction — there is no splice state to
 * corrupt.
 */
async function wireDerivedArtifacts(input: {
  context: PublishContext;
  adapterRef: string;
}): Promise<{ written: string[] }> {
  const resolved = await resolvePublishAdapter(input.context.projectId, {
    slug: input.context.slug,
  });
  const adapter = resolved?.adapter;
  if (!adapter?.capabilities.ownsDerivedArtifacts) return { written: [] };
  if (!adapter.commitArtifacts) return { written: [] };

  const artifacts = await buildArtifacts(input.context);
  await adapter.commitArtifacts({ ref: input.adapterRef, artifacts });
  return { written: artifacts.map((artifact) => artifact.path) };
}

/** The corpus as the engine's generators want it: newest first, hubs excluded
 *  (they are taxonomy, not posts), and only the columns those generators
 *  actually read. */
async function buildArtifacts(
  context: PublishContext,
): Promise<DerivedArtifact[]> {
  const rows = await PublishRepository.getManifestForWire(context.projectId);
  const posts: Post[] = rows
    .filter((row) => row.kind === "post")
    .map((row) => ({
      slug: row.path.split("/").filter(Boolean).at(-1) ?? "",
      title: row.title ?? "",
      description: row.description ?? "",
      date: (row.publishedAt ?? "").slice(0, 10),
      category: row.category ?? "",
      raw: "",
      wordCount: row.wordCount ?? 0,
      keyword: row.keyword,
      minutes: Math.max(1, Math.round((row.wordCount ?? 0) / 200)),
    }))
    .toSorted((a, b) => b.date.localeCompare(a.date));

  const cfg = engineConfig(context, rows);
  const today = new Date().toISOString().slice(0, 10);
  return [
    { path: "/sitemap.xml", content: sitemap(cfg, posts, { today }) },
    { path: "/rss.xml", content: rss(cfg, posts) },
    { path: "/llms.txt", content: llmsTxt(cfg, posts) },
    { path: "/llms-full.txt", content: llmsFull(cfg, posts) },
  ];
}

/**
 * The engine config the generators need, assembled from the project rather
 * than from a rankloop.toml — this deployment's manifest IS the config. The
 * taxonomy is derived from the hub rows already in the manifest, so a category
 * gets a hub entry only once its hub page actually exists.
 */
function engineConfig(
  context: PublishContext,
  rows: { kind: string; category: string | null; path: string }[],
): EngineConfig {
  const taxonomy: Record<string, string> = {};
  for (const row of rows) {
    if (row.kind !== "hub" || !row.category) continue;
    taxonomy[row.category] = row.path.split("/").filter(Boolean).at(-1) ?? "";
  }
  return {
    site: {
      url: context.siteUrl,
      name: "",
      description: "",
      blogPath: blogPathFrom(context.urlPattern),
      // The corpus these artifacts describe is markdown the GitHub adapter
      // committed; nothing here re-parses a file, but the config must say what
      // the site is.
      mode: "markdown",
    },
    taxonomy,
    // No generator in wire.ts reads either: the relevance gate ran back in S5
    // and the laws ran at the gate, both long before a sitemap needs writing.
    keywords: { positive: [], negative: [], classify: [] },
    laws: defaultLaws(),
  };
}

/** The pattern's first fixed segment is the blog root: "/compare/{slug}/"
 *  hangs off "compare". A pattern with no fixed segment falls back to "blog",
 *  which is where the engine's own default puts posts. */
function blogPathFrom(urlPattern: string | null): string {
  const segment = (urlPattern ?? "")
    .split("/")
    .find((part) => part !== "" && !part.includes("{"));
  return segment ?? "blog";
}

export const PublishLinksService = {
  planLinks,
  injectLinks,
  wireDerivedArtifacts,
};
