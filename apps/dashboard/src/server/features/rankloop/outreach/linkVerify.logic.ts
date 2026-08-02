// Link verification (spec 0029): did the link actually go live?
//
// This is the one transition rankloop can observe. Everything else on the
// outreach board is a human's memory aid — we cannot know whether an email
// was read — but whether a public page links to you is a fact, and fetching
// that page is the same thing any crawler does.
//
// Pure. The fetching lives in the service; this decides what the HTML means.

export interface FoundLink {
  href: string;
  /** The anchor text, so the board can show how you were described. */
  anchor: string;
  /** rel="nofollow" / "sponsored" / "ugc". Still a listing, still worth
   *  having, and materially different from a followed link — so it is
   *  recorded rather than filtered out or quietly counted as equal. */
  nofollow: boolean;
}

export type VerifyVerdict =
  | { state: "live"; links: FoundLink[] }
  /**
   * Not found. Deliberately NOT "rejected".
   *
   * A missing link may mean a moderation queue, an editor on holiday, a
   * listing on a different page, or markup we failed to parse. Marking
   * somebody's outreach rejected on that basis would be a guess presented as
   * a fact, and the user would stop believing the ones we do report.
   */
  | { state: "not_found" }
  | { state: "unreachable"; detail: string };

/** Everything a domain can be written as in an href. */
function hostVariants(domain: string): string[] {
  const bare = domain.trim().toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
  return [bare, `www.${bare}`];
}

/**
 * Find links to `domain` in a page's HTML.
 *
 * Matches on the parsed hostname rather than a substring of the raw href.
 * Substring matching is the obvious approach and it reports a false positive
 * on `https://not-rankloop.dev` and on `https://other.com/?ref=rankloop.dev`
 * — a link that mentions you in a query string is not a link to you.
 */
export function findLinksTo(html: string, domain: string): FoundLink[] {
  const wanted = new Set(hostVariants(domain));
  const found: FoundLink[] = [];

  const anchorRx = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRx)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";

    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(attrs);
    const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4];
    if (!href) continue;

    let host: string;
    try {
      // Protocol-relative hrefs are common in older markup.
      host = new URL(href.startsWith("//") ? `https:${href}` : href).hostname.toLowerCase();
    } catch {
      continue; // relative link — cannot be a link to another domain
    }
    if (!wanted.has(host)) continue;

    const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(attrs);
    const relValue = (rel?.[2] ?? rel?.[3] ?? rel?.[4] ?? "").toLowerCase();

    found.push({
      href,
      anchor: stripTags(inner).replace(/\s+/g, " ").trim(),
      nofollow: /\b(nofollow|sponsored|ugc)\b/.test(relValue),
    });
  }

  return found;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/**
 * Turn a fetch result into a verdict.
 *
 * A page we could not load is `unreachable`, never `not_found`. The
 * difference matters: "we looked and your link is not there" and "we could
 * not look" lead to different actions, and conflating them makes the board
 * report absences it never actually observed.
 */
export function verdictFor(input: {
  status: number | null;
  html: string | null;
  domain: string;
}): VerifyVerdict {
  if (input.status === null || input.html === null) {
    return { state: "unreachable", detail: "the page could not be fetched" };
  }
  if (input.status >= 400) {
    return { state: "unreachable", detail: `the page returned ${input.status}` };
  }

  const links = findLinksTo(input.html, input.domain);
  return links.length > 0 ? { state: "live", links } : { state: "not_found" };
}

/**
 * How a verdict changes a row.
 *
 * Only ever moves a row TO `linked`, and only from a state that was waiting
 * on an outcome. A row a human already marked `declined` is theirs; finding
 * a link on the page does not overrule them, because they may have withdrawn
 * the submission and be looking at somebody else's link.
 */
export function statusAfterVerify(input: {
  current: string;
  verdict: VerifyVerdict;
}): { status: string; linkLiveAt: boolean } | null {
  if (input.verdict.state !== "live") return null;
  if (input.current === "linked") return null; // already recorded
  if (!["to_contact", "sent", "replied"].includes(input.current)) return null;
  return { status: "linked", linkLiveAt: true };
}
