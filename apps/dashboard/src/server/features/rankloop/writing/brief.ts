// The writer's contract, assembled from stored facts (spec 0019). Everything
// here is pure: rows in, markdown out, no I/O and — the boundary the whole
// step is built on — no model call. The document a writer eventually receives
// is inspectable before a single word is generated because this module can be
// run against fixtures.
//
// The markdown itself is the engine's `renderBrief`, which is parity-tested
// byte-for-byte against the Python original. This module's job is to hand it
// real inputs and to append the two sections the engine deliberately doesn't
// know about: the site's own voice, and the page type S6a approved.

import { defaultLaws, renderBrief, slugify } from "@rankloop/engine";
import type {
  EngineConfig,
  KeywordRow,
  LawsConfig,
  Post,
  SerpData,
} from "@rankloop/engine";
import { z } from "zod";
import type { TemplateContract } from "@/server/features/rankloop/page-plan/contracts.logic";
import { readImpressions28 } from "@/server/features/rankloop/universe/notes.logic";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A keyword_backlog row, as stored. The imputation below reads notesJson
 *  rather than taking a number, so a caller cannot hand the brief a volume
 *  nobody measured. */
export type BriefKeywordRow = {
  keyword: string;
  category: string | null;
  format: string | null;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  score: number;
  source: string;
  notesJson: string | null;
};

/** A content_pages row — a page that exists on the site right now. */
export type BriefContentPage = {
  path: string;
  title: string | null;
  category: string | null;
};

export type BriefInputs = {
  site: { url: string; name: string; description: string };
  row: BriefKeywordRow;
  /** The approved page type this proposal is bound to; it is the brief's
   *  category, and the taxonomy marks it "<- this post". */
  pageTypeName: string;
  /** The type's stored contract, null when nothing understood is stored. */
  contract: TemplateContract | null;
  /** Its urlPattern, read only as a last-resort blog root (see blogRootFrom). */
  urlPattern: string | null;
  /** Every approved type's name — the site's taxonomy as the user approved it. */
  approvedTypeNames: string[];
  pages: BriefContentPage[];
  serp: SerpData | null;
  voiceCardMd: string | null;
  /** ISO date (YYYY-MM-DD). Injected, never read from the clock here. */
  today: string;
};

// ---------------------------------------------------------------------------
// The laws
// ---------------------------------------------------------------------------

/**
 * The page type's contract, merged OVER the engine's defaults.
 *
 * Only the five numbers S6a actually derived move. The rules that make the
 * corpus worth reading — banned phrases, the em-dash ban, first person, the
 * keyword-density ceiling — are the engine's and stay the engine's: a page
 * type is a shape, and no shape gets to relax the anti-slop laws. A missing or
 * unparseable contract leaves the defaults exactly as they are, which is the
 * same document a site with no competitor study would get.
 */
export function mergeContractLaws(
  contract: TemplateContract | null,
): LawsConfig {
  const laws = defaultLaws();
  if (!contract) return laws;
  const [wordMin, wordMax] = contract.wordBand;
  return {
    ...laws,
    wordMin,
    wordMax,
    h2Min: contract.h2Min,
    faqMin: contract.faqMin,
    internalLinksMin: contract.internalLinksMin,
  };
}

// ---------------------------------------------------------------------------
// Link candidates
// ---------------------------------------------------------------------------

/** Two pages sharing a first segment is a root; one is a coincidence. */
const POST_ROOT_MIN_PAGES = 2;
const DEFAULT_BLOG_ROOT = "blog";

function firstSegment(path: string): string | null {
  const segment = path.replace(/^\/+/, "").split("/")[0];
  return segment ? segment : null;
}

/**
 * The site's post root, derived from the pages that exist.
 *
 * The engine models one blog root and rebuilds every URL it prints as
 * `/{root}/{slug}/`. That is only honest if the root is the one this site
 * actually serves posts from, so it is measured rather than configured: the
 * first path segment the most posts share wins. With nothing to measure the
 * approved type's urlPattern supplies it, and failing that the engine's own
 * convention — at which point `toLinkPosts` will offer nothing, and the brief
 * says "none yet" instead of inventing neighbors.
 */
export function blogRootFrom(
  paths: string[],
  urlPattern: string | null,
): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const segment = firstSegment(path);
    if (segment === null) continue;
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const best = [...counts.entries()]
    .filter(([, pages]) => pages >= POST_ROOT_MIN_PAGES)
    // Count first, then alphabetical: a tie must resolve the same way on every
    // rebuild or the same proposal renders two different briefs.
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return best[0];
  return firstSegment(urlPattern ?? "") ?? DEFAULT_BLOG_ROOT;
}

/**
 * Real pages the writer may link to, in the shape the engine's
 * `linkCandidates` reads (it does the same-category-first ordering and the
 * slug dedupe; this only decides what is eligible).
 *
 * Eligibility is strict on purpose: the engine prints `/{root}/{slug}/`, so a
 * page is only offered when that reconstruction IS its stored path. A page one
 * level deeper, or under a different root, would be rendered as a URL the site
 * does not serve — and a brief that hands the writer a 404 has broken the one
 * promise internal-link grounding makes.
 */
export function toLinkPosts(
  pages: BriefContentPage[],
  blogRoot: string,
): Post[] {
  const prefix = `/${blogRoot}/`;
  const posts: Post[] = [];
  for (const page of pages) {
    if (!page.path.startsWith(prefix)) continue;
    const slug = page.path.slice(prefix.length).replace(/\/+$/, "");
    if (slug === "" || slug.includes("/")) continue;
    posts.push({
      slug,
      title: page.title ?? slug,
      category: page.category ?? "",
      // The brief reads slug, title and category and nothing else; the rest of
      // Post describes a parsed file, which a manifest row is not.
      description: "",
      date: "",
      raw: "",
      wordCount: 0,
      keyword: null,
      minutes: 0,
    });
  }
  return posts;
}

// ---------------------------------------------------------------------------
// The keyword row
// ---------------------------------------------------------------------------

/**
 * The row as the engine prints it, with S5's imputed volume.
 *
 * Same rule as `imputeVolume` (keywordAdmission) and `effectiveVolume` (the
 * planner): Search Console impressions beat a vendor zero, because the vendors
 * price exactly these long-tail queries below their own reporting floor. The
 * brief goes one step further than either and says where the number came from
 * in `provenance` — a writer told "volume: 412" deserves to know that 412 is
 * the site's own measured impressions rather than a vendor's estimate.
 */
function toKeywordRow(row: BriefKeywordRow): KeywordRow {
  const impressions28 = readImpressions28(row.notesJson);
  const searchVolume =
    impressions28 === null
      ? row.searchVolume
      : Math.max(row.searchVolume ?? 0, impressions28);

  return {
    keyword: row.keyword,
    category: row.category,
    format: row.format,
    searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    intent: row.intent,
    score: row.score,
    source: row.source,
    notes: volumeProvenance(row.searchVolume, impressions28),
  };
}

function volumeProvenance(
  vendorVolume: number | null,
  impressions28: number | null,
): string | null {
  if (impressions28 === null) return null;
  if (impressions28 <= (vendorVolume ?? 0)) return null;
  const vendor =
    vendorVolume === null
      ? "no vendor priced this keyword at all"
      : `a vendor estimate of ${vendorVolume}`;
  // Plain digits, matching how the engine prints every other number in the
  // brief; a thousands separator here would read as a different measurement.
  return `volume is your own Search Console: ${impressions28} impressions in 28 days, against ${vendor}`;
}

// ---------------------------------------------------------------------------
// Stored SERP -> the engine's SerpData
// ---------------------------------------------------------------------------

const organicSchema = z.array(
  z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullish(),
  }),
);
const paaSchema = z.array(z.string());

/**
 * Read a serp_snapshots row back into the engine's shape.
 *
 * Both columns degrade to nothing rather than throwing: a snapshot written by
 * an older shape must cost the brief its Search-context section, never the
 * whole document. The engine already has an honest line for an absent SERP.
 */
export function parseSerpSnapshot(snapshot: {
  organicJson: string;
  paaJson: string | null;
}): SerpData | null {
  const organic = parseJson(organicSchema, snapshot.organicJson) ?? [];
  const paa = parseJson(paaSchema, snapshot.paaJson) ?? [];
  if (organic.length === 0 && paa.length === 0) return null;
  return {
    organic: organic.map((result) => ({
      url: result.url,
      title: result.title,
      description: result.description ?? undefined,
    })),
    paa,
  };
}

function parseJson<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The two app-supplied sections
// ---------------------------------------------------------------------------

/** Contract block ids as the writer should read them; the ids themselves are
 *  contracts.logic's internal vocabulary and mean nothing to a human. */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
  dataTable: "a data table",
  faq: "an FAQ block",
  byline: "a byline",
  dateModified: "a visible date-modified stamp",
};

/**
 * The site's voice, in the user's own words.
 *
 * When there is none, the brief says so. The temptation here is to synthesize
 * a persona from the domain and the niche, and that is exactly how a corpus
 * ends up sounding like every other generated corpus: a writer told to be
 * "an approachable expert" writes marketing, while a writer told nothing
 * writes plainly.
 */
function voiceCardSection(voiceCardMd: string | null): string {
  const body = voiceCardMd?.trim();
  return [
    "## Voice card",
    "",
    // The em dash the spec quotes this line with is deliberately not here: the
    // laws two sections up ban em dashes, and a writer mirrors the punctuation
    // of the document it is handed.
    body
      ? body
      : "No voice card yet, so write plainly and in first person, as yourself.",
    "",
  ].join("\n");
}

/** The approved page type, rendered as requirements rather than as a card. */
function pageTypeContractSection(
  pageTypeName: string,
  contract: TemplateContract | null,
): string {
  const lines = [`## Page type contract: ${pageTypeName}`, ""];
  if (!contract) {
    lines.push(
      "Nothing is stored for this page type, so the hard requirements above are the house laws, unchanged.",
      "",
    );
    return lines.join("\n");
  }

  const blocks = contract.requiredBlocks.map(
    (block) => BLOCK_LABELS[block] ?? block,
  );
  const [wordMin, wordMax] = contract.wordBand;
  lines.push(
    "What a page of this type has to carry. This was settled when you approved the type; it is not a suggestion.",
    "",
    `- Required blocks: ${blocks.length > 0 ? blocks.join(", ") : "none were measured, so build whatever shape the topic needs"}`,
    `- Word band: ${wordMin} to ${wordMax} words`,
    `- Schema type: ${contract.schemaType} (the JSON-LD @type for the page)`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The whole brief: the engine's document, then the two sections it leaves to
 * the app.
 *
 * The engine renders; this function only decides what is true. That split is
 * why a wording change here can never drift the parity-tested body.
 */
export function assembleBrief(inputs: BriefInputs): string {
  const blogRoot = blogRootFrom(
    inputs.pages.map((page) => page.path),
    inputs.urlPattern,
  );

  const config: EngineConfig = {
    site: {
      url: inputs.site.url,
      name: inputs.site.name,
      description: inputs.site.description,
      blogPath: blogRoot,
      // Unread by renderBrief; the publish adapter owns the real format.
      mode: "markdown",
    },
    // Category -> hub slug, from the types the user approved. The relevance
    // patterns are empty because renderBrief never reads them: the gate ran
    // back in S5, and a keyword only reaches a brief by having passed it.
    taxonomy: taxonomyFrom(inputs.approvedTypeNames, inputs.pageTypeName),
    keywords: { positive: [], negative: [], classify: [] },
    laws: mergeContractLaws(inputs.contract),
  };

  const body = renderBrief({
    cfg: config,
    row: toKeywordRow(inputs.row),
    category: inputs.pageTypeName,
    posts: toLinkPosts(inputs.pages, blogRoot),
    serp: inputs.serp,
    today: inputs.today,
  });

  return [
    body,
    voiceCardSection(inputs.voiceCardMd),
    pageTypeContractSection(inputs.pageTypeName, inputs.contract),
  ].join("\n");
}

/** The approved types as the engine's taxonomy. This type is always in it:
 *  the engine marks the post's own category, and a category missing from the
 *  taxonomy would print a brief whose site map omits the page being written.
 *
 *  Exported for the gate: the "category known" law is graded against this
 *  exact map, so a second definition of it would judge the writer against a
 *  taxonomy the brief never showed it. */
export function taxonomyFrom(
  approvedTypeNames: string[],
  pageTypeName: string,
): Record<string, string> {
  const names = approvedTypeNames.includes(pageTypeName)
    ? approvedTypeNames
    : [...approvedTypeNames, pageTypeName];
  return Object.fromEntries(names.map((name) => [name, slugify(name)]));
}
