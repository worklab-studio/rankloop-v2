/**
 * HTML page analyzer using cheerio.
 *
 * Extracts SEO-relevant data from a page's HTML:
 * title, meta description, headings, images, links, canonical, OG tags,
 * structured data, robots meta, word count, hreflang.
 */
import * as cheerio from "cheerio";
import { normalizeUrl, isSameOrigin } from "./url-utils";
import type { PageAnalysis, PageLink } from "./types";

/**
 * Normalize a claimed content date to an ISO string, or null when it doesn't
 * parse. Accepts anything Date.parse does (full ISO, date-only sitemap
 * lastmods, RFC 2822). Sites put all sorts of junk in these fields — a bad
 * value degrades to null rather than failing the page.
 */
export function normalizeContentDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

// JSON-LD payloads nest (@graph, mainEntity, arrays); walk a bounded slice of
// the tree for the first date key. The caps keep a pathological 2MiB blob of
// nested JSON from eating the crawl step's CPU budget.
const JSON_LD_MAX_DEPTH = 5;
const JSON_LD_MAX_NODES = 200;

function isJsonLdRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findJsonLdDate(node: unknown, key: string): string | null {
  let visited = 0;
  const walk = (value: unknown, depth: number): string | null => {
    if (visited >= JSON_LD_MAX_NODES || depth > JSON_LD_MAX_DEPTH) return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (!isJsonLdRecord(value)) return null;
    visited += 1;
    const record = value;
    const direct = record[key];
    if (typeof direct === "string") {
      const normalized = normalizeContentDate(direct);
      if (normalized) return normalized;
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(node, 0);
}

/**
 * Extract publishedAt/modifiedAt from the loaded document. First source that
 * yields a parseable value wins: JSON-LD datePublished/dateModified →
 * article:published_time/modified_time meta → (published only) the first
 * `<time datetime>`. Anything malformed degrades to null — dates are
 * best-effort metadata, never a reason to fail a page.
 */
function extractContentDates(api: cheerio.CheerioAPI): {
  publishedAt: string | null;
  modifiedAt: string | null;
} {
  let publishedAt: string | null = null;
  let modifiedAt: string | null = null;

  api('script[type="application/ld+json"]').each((_, el) => {
    if (publishedAt && modifiedAt) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(api(el).text());
    } catch {
      return; // malformed JSON-LD is common; skip the block
    }
    publishedAt ??= findJsonLdDate(parsed, "datePublished");
    modifiedAt ??= findJsonLdDate(parsed, "dateModified");
  });

  publishedAt ??= normalizeContentDate(
    api('meta[property="article:published_time"]').first().attr("content"),
  );
  modifiedAt ??= normalizeContentDate(
    api('meta[property="article:modified_time"]').first().attr("content"),
  );

  // <time datetime> is the weakest published signal (it can mark any date on
  // the page), so it only fills in when the structured sources are silent —
  // and never claims to be a modification date.
  publishedAt ??= normalizeContentDate(
    api("time[datetime]").first().attr("datetime"),
  );

  return { publishedAt, modifiedAt };
}

/**
 * Analyze an HTML string and extract all SEO-relevant data.
 */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  statusCode: number,
  responseTimeMs: number,
  redirectUrl: string | null = null,
): PageAnalysis {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();

  const metaDescription =
    $('meta[name="description"]').first().attr("content")?.trim() ?? "";

  const canonical = $('link[rel="canonical"]').first().attr("href") ?? null;

  const robotsMeta = $('meta[name="robots"]').first().attr("content") ?? null;

  // --- Open Graph ---
  const ogTitle =
    $('meta[property="og:title"]').first().attr("content") ?? null;
  const ogDescription =
    $('meta[property="og:description"]').first().attr("content") ?? null;
  const ogImage =
    $('meta[property="og:image"]').first().attr("content") ?? null;

  // --- Headings ---
  const h1s: string[] = [];
  $("h1").each((_, el) => {
    h1s.push($(el).text().trim());
  });

  const headingOrder: number[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag =
      "tagName" in el && typeof el.tagName === "string"
        ? el.tagName.toLowerCase()
        : null;
    if (tag) {
      const level = parseInt(tag.charAt(1), 10);
      if (!isNaN(level)) headingOrder.push(level);
    }
  });

  // --- Word count (visible text in body) ---
  // Remove script/style/noscript tags, then count words in remaining text
  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript, svg").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  const images: Array<{ src: string | null; alt: string | null }> = [];
  $("img").each((_, el) => {
    images.push({
      src: $(el).attr("src") ?? null,
      alt: $(el).attr("alt") ?? null,
    });
  });

  // --- Links (deduped by target URL; first anchor wins) ---
  const linksByTarget = new Map<string, PageLink>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Skip javascript:, mailto:, tel:, #anchors
    if (/^(javascript:|mailto:|tel:|#)/.test(href)) return;

    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    if (linksByTarget.has(resolved)) return;

    const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
    const rel = $(el).attr("rel")?.toLowerCase() ?? "";
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  });
  const links = Array.from(linksByTarget.values());

  // --- Structured data (JSON-LD) ---
  let hasStructuredData = false;
  $('script[type="application/ld+json"]').each(() => {
    hasStructuredData = true;
  });

  const hreflangTags: string[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const hreflang = $(el).attr("hreflang");
    if (hreflang) hreflangTags.push(hreflang);
  });

  const { publishedAt, modifiedAt } = extractContentDates($);

  return {
    url: pageUrl,
    statusCode,
    redirectUrl,
    responseTimeMs,
    title,
    metaDescription,
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    h1s,
    headingOrder,
    wordCount,
    bodyText,
    publishedAt,
    modifiedAt,
    images,
    links,
    hasStructuredData,
    hreflangTags,
  };
}
