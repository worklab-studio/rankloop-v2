// Rule 2 of spec 0021, as code: rankloop only ever edits what rankloop owns.
//
// Every contextual link this product injects lives between two HTML comments
// that rankloop wrote. Nothing outside them is read, rewritten or reformatted
// — the merge splices at the delimiters and copies the rest of the document
// through byte for byte. A user who deletes the block deletes everything
// rankloop ever put in their page, and the next publish appends a fresh one
// rather than hunting for what went missing.
//
// Pure string work, no I/O — exhaustively unit-tested in
// relatedBlock.logic.test.ts, which is what the spec's owned-block proof is.

/** The delimiters. Hard-coded on purpose in the tests too: renaming a marker
 *  orphans every block already living on a user's site, so it should break a
 *  test that spells the old name out. */
const START = "<!-- rankloop:related start -->";
const END = "<!-- rankloop:related end -->";

/**
 * How many links one block may carry.
 *
 * The block accumulates: publishing a second article into the same
 * neighbourhood adds its link rather than replacing the first one, because a
 * link that silently disappears from a live page a week after it was injected
 * is worse than no link at all. Five is where a "Related" note stops reading
 * as an aside and starts reading as a directory, so the oldest fall off.
 */
const MAX_RELATED_LINKS = 5;

/** HTML for a WordPress post body, markdown for a file the GitHub adapter
 *  commits. The delimiters are identical in both — an HTML comment survives
 *  a markdown renderer untouched — so a site that switches adapters still
 *  finds its own blocks. */
type RelatedBlockFormat = "html" | "markdown";

type RelatedLink = {
  /** Site-relative, as stored in content_pages.path. */
  path: string;
  title: string;
};

type RelatedBlockMerge = {
  /** `malformed` means the page carries a half-block — a start with no end, an
   *  end with no start, or a start nested inside a block. Something (a user, a
   *  plugin, a bad merge) has already damaged the delimiters, and splicing
   *  against a boundary we cannot locate is exactly how prose gets eaten. The
   *  content comes back untouched and the caller records a skip. */
  outcome: "unchanged" | "replaced" | "appended" | "malformed";
  content: string;
  /** What the block holds afterwards. Empty on `malformed`. */
  links: RelatedLink[];
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

type BlockSpan = {
  /** Index of the first character of START. */
  start: number;
  /** Index one past the last character of END. */
  end: number;
  inner: string;
};

/**
 * Every well-formed block in the document, or null if the delimiters are
 * damaged anywhere in it.
 *
 * All-or-nothing by design: a document with one good block and one stray
 * marker is a document whose boundaries we cannot trust, and "edit the part
 * that still parses" is how a partial rewrite lands in the middle of somebody's
 * paragraph.
 */
function scanBlocks(content: string): BlockSpan[] | null {
  const spans: BlockSpan[] = [];
  let cursor = 0;
  for (;;) {
    const start = content.indexOf(START, cursor);
    const strayEnd = content.indexOf(END, cursor);
    if (start === -1 && strayEnd === -1) return spans;
    // An end marker reached before any start (or with no start at all) closes
    // a block that was never opened.
    if (start === -1 || strayEnd < start) return null;
    const innerStart = start + START.length;
    const innerEnd = content.indexOf(END, innerStart);
    if (innerEnd === -1) return null;
    const nextStart = content.indexOf(START, innerStart);
    if (nextStart !== -1 && nextStart < innerEnd) return null;
    spans.push({
      start,
      end: innerEnd + END.length,
      inner: content.slice(innerStart, innerEnd),
    });
    cursor = innerEnd + END.length;
  }
}

const HTML_LINK = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

/**
 * Read the links back out of a block body.
 *
 * Both syntaxes are tried against every block regardless of the format being
 * written now: a project that moved from WordPress to a Claude-built site has
 * HTML blocks on pages the GitHub adapter is about to rewrite, and parsing
 * only the current format would silently drop links that are live today.
 */
function parseLinks(inner: string): RelatedLink[] {
  const links: RelatedLink[] = [];
  for (const match of inner.matchAll(HTML_LINK)) {
    links.push({
      path: unescapeHtml(match[1]),
      title: unescapeHtml(stripTags(match[2])),
    });
  }
  for (const match of inner.matchAll(MARKDOWN_LINK)) {
    links.push({ path: match[2], title: unescapeMarkdown(match[1]) });
  }
  return links.filter((link) => link.path !== "" && link.title !== "");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([[\]\\])/g, "$1");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * A title arriving from a page manifest is site data, not a literal: it can
 * carry angle brackets, and it can carry `-->`. A title that closed the block
 * early would put rankloop's own markup into the user's prose — the one thing
 * rule 2 exists to prevent — so comment syntax is removed rather than escaped,
 * in both formats, before anything else happens to the string.
 */
function sanitize(value: string): string {
  return value
    .replace(/<!--/g, "")
    .replace(/--!?>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([[\]\\])/g, "\\$1");
}

/** Parentheses inside an inline-link destination end it early; percent-encoding
 *  them is what keeps a path like /guide/(2026)/ pointing where it should. */
function escapeMarkdownPath(value: string): string {
  return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function renderBlock(links: RelatedLink[], format: RelatedBlockFormat): string {
  if (format === "html") {
    const items = links
      .map(
        (link) =>
          `  <li><a href="${escapeHtml(link.path)}">${escapeHtml(link.title)}</a></li>`,
      )
      .join("\n");
    return [
      START,
      '<nav class="rankloop-related" aria-label="Related">',
      "  <p><strong>Related</strong></p>",
      "  <ul>",
      items,
      "  </ul>",
      "</nav>",
      END,
    ].join("\n");
  }
  const items = links
    .map(
      (link) =>
        `- [${escapeMarkdownText(link.title)}](${escapeMarkdownPath(link.path)})`,
    )
    .join("\n");
  return [START, "", "**Related**", "", items, "", END].join("\n");
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Trailing slashes are a permalink setting, not an identity: /a and /a/ are
 *  one page, and treating them as two is how the same link gets injected
 *  twice under two spellings. */
function linkKey(path: string): string {
  return path.replace(/\/+$/, "").toLowerCase();
}

function dedupe(links: RelatedLink[]): RelatedLink[] {
  const seen = new Set<string>();
  const kept: RelatedLink[] = [];
  for (const link of links) {
    const path = sanitize(link.path);
    const title = sanitize(link.title);
    if (path === "" || title === "") continue;
    const key = linkKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ path, title });
  }
  return kept;
}

/**
 * Put `links` in the page's owned block and hand back the whole document.
 *
 * The three cases the spec's proof turns on:
 *   - no block yet → one is appended, and the user's text is the result's
 *     byte-identical prefix;
 *   - a block already there → only the span between the delimiters changes;
 *   - the same links again → the result is `===` the input, so the caller
 *     writes nothing to the site at all.
 *
 * Incoming links are listed before the ones already stored so the newest
 * neighbour reads first, and re-running with the same input still produces the
 * same bytes — the existing ones simply dedupe away behind their own copies.
 */
export function mergeRelatedBlock(input: {
  content: string;
  links: RelatedLink[];
  format: RelatedBlockFormat;
}): RelatedBlockMerge {
  const spans = scanBlocks(input.content);
  if (spans === null) {
    return { outcome: "malformed", content: input.content, links: [] };
  }

  const incoming = dedupe(input.links);
  const existing = dedupe(spans.flatMap((span) => parseLinks(span.inner)));
  // Nothing to add and nothing already there: leave the page exactly as it is
  // rather than appending an empty "Related" heading nobody asked for.
  if (incoming.length === 0 && existing.length === 0) {
    return { outcome: "unchanged", content: input.content, links: [] };
  }

  const links = dedupe([...incoming, ...existing]).slice(0, MAX_RELATED_LINKS);
  const rendered = renderBlock(links, input.format);

  if (spans.length === 0) {
    const separator = input.content.endsWith("\n") ? "\n" : "\n\n";
    return {
      outcome: "appended",
      content: `${input.content}${separator}${rendered}\n`,
      links,
    };
  }

  // The first block is rewritten where it stands; any later ones are removed.
  // Duplicates can only be rankloop's own markup (nobody hand-writes these
  // delimiters), and leaving a second "Related" list on the page would make
  // every subsequent merge produce two of everything.
  const [first, ...extra] = spans;
  let content =
    input.content.slice(0, first.start) +
    rendered +
    input.content.slice(first.end);
  const shift = rendered.length - (first.end - first.start);
  for (const span of extra.toReversed()) {
    content =
      content.slice(0, span.start + shift) + content.slice(span.end + shift);
  }

  return {
    outcome: content === input.content ? "unchanged" : "replaced",
    content,
    links,
  };
}
