import type {
  CrawledPageResult,
  PageFetchClass,
} from "@/server/lib/audit/types";
import { sha256Hex } from "@/server/lib/audit/ids";
import { normalizeUrl } from "@/server/lib/audit/url-utils";

const CRAWL_USER_AGENT = "OpenSEO-Audit/1.0";
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Cap on persisted same-origin outlink paths per page. 50 covers real
// in-content linking; past that it's nav/footer boilerplate, and site study's
// inlink inversion only needs the graph shape, not every mega-menu edge.
const MAX_OUTLINK_PATHS_PER_PAGE = 50;

/** Same-origin outlink paths, deduped in document order, capped at 50. Paths
 *  (not full URLs) so the inlink inversion is origin/protocol agnostic. */
function collectOutlinkPaths(
  links: Array<{ targetUrl: string; isInternal: boolean }>,
): string[] {
  const paths = new Set<string>();
  for (const link of links) {
    if (!link.isInternal) continue;
    if (paths.size >= MAX_OUTLINK_PATHS_PER_PAGE) break;
    try {
      paths.add(new URL(link.targetUrl).pathname);
    } catch {
      // Unparseable target — skip; links are already normalized upstream.
    }
  }
  return [...paths];
}

/**
 * Markers of a bot-mitigation challenge page. We classify these honestly as
 * "blocked" instead of recording the challenge HTML as if it were the page.
 */
const CHALLENGE_BODY_MARKERS = [
  "just a moment...",
  "challenge-platform",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "verifying you are human",
];

function classifyFetch(
  statusCode: number,
  headers: Headers,
  bodySnippet: string,
): PageFetchClass {
  if (statusCode === 0) return "error";
  if (headers.get("cf-mitigated")) return "blocked";
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    return "blocked";
  }
  if (statusCode === 503) {
    const snippet = bodySnippet.toLowerCase();
    if (CHALLENGE_BODY_MARKERS.some((marker) => snippet.includes(marker))) {
      return "blocked";
    }
  }
  return "ok";
}

/** Parse `Link: <url>; rel="canonical"` response headers. */
function parseLinkHeaderCanonical(
  linkHeader: string | null,
  pageUrl: string,
): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;([^]*)/);
    if (!match) continue;
    if (/rel\s*=\s*"?canonical"?/i.test(match[2])) {
      return normalizeUrl(match[1].trim(), pageUrl);
    }
  }
  return null;
}

/**
 * Fetch a page and hand back its raw HTML, under the same rules crawlPage
 * applies: OpenSEO-Audit/1.0, a 15-second timeout, a 2 MiB body ceiling, and
 * the same bot-challenge verdict. The competitor study extracts a different
 * feature set than the audit's page analysis (data tables, FAQ blocks,
 * bylines) so it needs the document crawlPage consumes internally — but the
 * two must agree on what "blocked" means, because that verdict is what
 * degrades a study to sitemap-only.
 *
 * Redirects are followed rather than recorded: the study wants the page a
 * reader lands on, not the hop chain the audit maps.
 */
export async function fetchPageHtml(url: string): Promise<{
  statusCode: number;
  fetchClass: PageFetchClass;
  html: string;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    const isHtml = (response.headers.get("content-type") ?? "").includes(
      "text/html",
    );
    const body = isHtml ? await readTextUpTo(response, MAX_HTML_BYTES) : "";
    const classified = classifyFetch(
      response.status,
      response.headers,
      body.slice(0, 4_000),
    );
    // A 404 is not a block — keep the two apart so a site full of dead links
    // never reads as a WAF and strands the study on the sitemap.
    const fetchClass: PageFetchClass =
      classified === "ok" && response.status >= 400 ? "error" : classified;

    return {
      statusCode: response.status,
      fetchClass,
      html: fetchClass === "ok" && isHtml ? body : "",
    };
  } catch (error) {
    console.warn(`Failed to fetch ${url}:`, error);
    return { statusCode: 0, fetchClass: "error", html: "" };
  }
}

export async function crawlPage(
  url: string,
  crawlDepth: number | null,
  inSitemap: boolean,
  sitemapLastmod: string | null = null,
): Promise<CrawledPageResult> {
  const startTime = Date.now();

  try {
    // Manual redirect handling: each hop is recorded as its own page row and
    // its target is enqueued by the frontier, so redirect chains and loops are
    // detectable from the recorded rows. Trailing-slash redirects (/docs ->
    // /docs/) need no special handling: normalizeUrl preserves trailing
    // slashes, so /docs and /docs/ are distinct URLs and the redirect resolves
    // to its canonical target instead of cycling back to its own source.
    const response = await fetch(url, {
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const responseTimeMs = Date.now() - startTime;
    const statusCode = response.status;
    const xRobotsTag = response.headers.get("x-robots-tag");
    const headerCanonicalUrl = parseLinkHeaderCanonical(
      response.headers.get("link"),
      url,
    );

    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers.get("location");
      const redirectUrl = location ? normalizeUrl(location, url) : null;
      return emptyPageResult({
        url,
        statusCode,
        fetchClass: "ok",
        redirectUrl,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        crawlDepth,
        inSitemap,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");
    // Large pages make Cheerio disproportionately expensive and can exhaust a
    // crawl step's CPU or isolate memory. The first 2 MiB still contains the
    // SEO metadata and navigation needed by the audit in normal documents.
    const body = isHtml ? await readTextUpTo(response, MAX_HTML_BYTES) : "";
    const fetchClass = classifyFetch(
      statusCode,
      response.headers,
      body.slice(0, 4_000),
    );

    if (!isHtml || fetchClass !== "ok" || statusCode >= 400) {
      return emptyPageResult({
        url,
        statusCode,
        fetchClass,
        redirectUrl: null,
        responseTimeMs,
        xRobotsTag,
        headerCanonicalUrl,
        crawlDepth,
        inSitemap,
      });
    }

    // Dynamic import keeps cheerio (page-analyzer's HTML parser) out of the
    // worker's startup module graph: SiteAuditWorkflow is re-exported from
    // src/server.ts, so a static import would evaluate cheerio in every
    // isolate's baseline heap, not just when an audit actually crawls.
    const { analyzeHtml, normalizeContentDate } =
      await import("@/server/lib/audit/page-analyzer");
    const analysis = analyzeHtml(body, url, statusCode, responseTimeMs);
    // The HTML sources win; sitemap lastmod only fills the gaps. It claims
    // "last modified", so it backs publishedAt too — a page that states no
    // dates at all was, at worst, published when it was last modified.
    const lastmodFallback = normalizeContentDate(sitemapLastmod);
    const robotsDirectives = [analysis.robotsMeta, xRobotsTag]
      .filter(Boolean)
      .join(",")
      .toLowerCase();
    const isIndexable = !robotsDirectives.includes("noindex");
    const headingCount = (level: number) =>
      analysis.headingOrder.filter((h) => h === level).length;

    return {
      id: crypto.randomUUID(),
      url,
      statusCode,
      fetchClass,
      redirectUrl: null,
      title: analysis.title,
      metaDescription: analysis.metaDescription,
      canonicalUrl: analysis.canonical
        ? (normalizeUrl(analysis.canonical, url) ?? analysis.canonical)
        : null,
      robotsMeta: analysis.robotsMeta,
      xRobotsTag,
      headerCanonicalUrl,
      ogTitle: analysis.ogTitle,
      ogDescription: analysis.ogDescription,
      ogImage: analysis.ogImage,
      h1Count: analysis.h1s.filter((h) => h.length > 0).length,
      h2Count: headingCount(2),
      h3Count: headingCount(3),
      h4Count: headingCount(4),
      h5Count: headingCount(5),
      h6Count: headingCount(6),
      headingOrder: analysis.headingOrder,
      wordCount: analysis.wordCount,
      contentHash: analysis.bodyText
        ? await sha256Hex(analysis.bodyText)
        : null,
      publishedAt: analysis.publishedAt ?? lastmodFallback,
      modifiedAt: analysis.modifiedAt ?? lastmodFallback,
      isHtml: true,
      imagesTotal: analysis.images.length,
      // Only a truly absent alt attribute counts: alt="" is the correct
      // markup for decorative images.
      imagesMissingAlt: analysis.images.filter((img) => img.alt === null)
        .length,
      images: analysis.images,
      links: analysis.links,
      hasStructuredData: analysis.hasStructuredData,
      hreflangTags: analysis.hreflangTags,
      isIndexable,
      responseTimeMs,
      crawlDepth,
      inSitemap,
      outlinkPaths: collectOutlinkPaths(analysis.links),
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    console.warn(`Failed to crawl ${url}:`, error);
    return emptyPageResult({
      url,
      statusCode: 0,
      fetchClass: "error",
      redirectUrl: null,
      responseTimeMs,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      crawlDepth,
      inSitemap,
    });
  }
}

async function readTextUpTo(response: Response, maxBytes: number) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (bytesRead >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());
  return parts.join("");
}

function emptyPageResult(input: {
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  responseTimeMs: number;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  crawlDepth: number | null;
  inSitemap: boolean;
}): CrawledPageResult {
  return {
    id: crypto.randomUUID(),
    url: input.url,
    statusCode: input.statusCode,
    fetchClass: input.fetchClass,
    redirectUrl: input.redirectUrl,
    title: "",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: input.xRobotsTag,
    headerCanonicalUrl: input.headerCanonicalUrl,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [],
    wordCount: 0,
    contentHash: null,
    publishedAt: null,
    modifiedAt: null,
    isHtml: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: false,
    responseTimeMs: input.responseTimeMs,
    crawlDepth: input.crawlDepth,
    inSitemap: input.inSitemap,
    outlinkPaths: null,
  };
}
