/** Text utilities ported from rankloop 0.2 (brief.slugify, laws._strip_tags,
 * laws._article_of, laws._frontmatter, wire._x). Behavior is parity-tested
 * against the Python implementation — change with fixtures in hand. */

export function slugify(kw: string): string {
  const s = kw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.replace(/-{2,}/g, "-").slice(0, 70);
}

/** XML text escaping: & < > only (html.escape(quote=False)). Attribute
 * quoting never occurs in the wire artifacts. */
export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A pragmatic subset of Python html.unescape: the named entities that occur
// in real post corpora plus numeric forms. Prose measurement, not rendering.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  middot: "·", times: "×", deg: "°", copy: "©",
};

export function unescapeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? whole : String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? whole : String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** The prose block the content laws measure: <article>, else <main>, else
 * the whole document (boilerplate then inflates word counts — semantic
 * tags pay off). */
export function articleOf(htmlSrc: string): string {
  for (const tag of ["article", "main"]) {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(htmlSrc);
    if (m) return m[1]!;
  }
  return htmlSrc;
}

export function stripTags(htmlSrc: string): string {
  return unescapeEntities(htmlSrc.replace(/<[^>]+>/g, " "));
}

/** `--- key: value ---` frontmatter parser: flat string keys only, quotes
 * stripped. Deliberately not YAML — same contract as rankloop 0.2. */
export function frontmatter(text: string): [Record<string, string>, string] {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0]!.trim() !== "---") return [{}, text];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      const meta: Record<string, string> = {};
      for (const line of lines.slice(1, i)) {
        if (line.includes(":") && !line.trimStart().startsWith("#")) {
          const idx = line.indexOf(":");
          const k = line.slice(0, idx);
          const v = line.slice(idx + 1);
          meta[k.trim().toLowerCase()] = v.trim().replace(/^['"]+|['"]+$/g, "");
        }
      }
      return [meta, lines.slice(i + 1).join("\n")];
    }
  }
  return [{}, text];
}

/** Python str.split() semantics: split on any whitespace, drop empties. */
export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Strict YYYY-MM-DD parse -> UTC ms, or null. Rejects non-dates like
 * 2026-02-30 (Python date.fromisoformat parity for the corpus format). */
export function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return t;
}

/** Escape a literal string for embedding in a RegExp (re.escape). */
export function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count non-overlapping occurrences of `needle` (str.count). */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) return n;
    n += 1;
    i = hit + needle.length;
  }
}
