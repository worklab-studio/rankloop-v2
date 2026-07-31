// Markdown -> HTML, for the one target that cannot take markdown.
//
// WordPress stores post_content as HTML; the writer emits the markdown the
// engine's laws are written against. Something has to convert, and it is a
// deliberate choice that it is 120 lines here rather than a markdown library:
// the input is not arbitrary markdown, it is a gated rankloop draft, and the
// gate has already established what that contains — headings, paragraphs,
// lists, links, a table or two, and no raw HTML. This handles that grammar
// exactly and escapes everything else, which is the safer failure: an
// unsupported construct renders as its own text instead of as markup nobody
// reviewed.
//
// The same trade the engine makes in the other direction (wire.ts turns HTML
// into markdown with regexes and says so).

// The placeholder is delimited by NULs (written as escapes, never as raw
// bytes in this file) because a NUL cannot survive in a draft: any
// printable sentinel could collide with text the writer actually produced.
const CODE_OPEN = "\u0000rl-code-";
const CODE_CLOSE = "\u0000";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * Code spans come out first and go back last, so a `**` inside backticks is
 * printed rather than read as emphasis.
 */
export function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`;
  });

  let html = escapeHtml(withoutCode);
  // Links before emphasis: an underscore inside a URL is part of the URL.
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");

  return html.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"),
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Block = { lines: string[] };

/** Split on blank lines, keeping fenced code blocks whole. */
function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      current.push(line);
      continue;
    }
    if (!fenced && line.trim() === "") {
      if (current.length > 0) blocks.push({ lines: current });
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push({ lines: current });
  return blocks;
}

function renderHeading(line: string): string | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  const level = match[1].length;
  return `<h${level}>${renderInline(match[2].trim())}</h${level}>`;
}

function renderList(lines: string[]): string | null {
  const ordered = /^\s*\d+[.)]\s+/;
  const unordered = /^\s*[-*+]\s+/;
  const isOrdered = lines.every((line) => ordered.test(line));
  const isUnordered = lines.every((line) => unordered.test(line));
  if (!isOrdered && !isUnordered) return null;
  const tag = isOrdered ? "ol" : "ul";
  const items = lines.map(
    (line) =>
      `<li>${renderInline(line.replace(isOrdered ? ordered : unordered, ""))}</li>`,
  );
  return `<${tag}>\n${items.join("\n")}\n</${tag}>`;
}

function renderQuote(lines: string[]): string | null {
  if (!lines.every((line) => line.trimStart().startsWith(">"))) return null;
  const text = lines
    .map((line) => line.trimStart().replace(/^>\s?/, ""))
    .join(" ");
  return `<blockquote><p>${renderInline(text)}</p></blockquote>`;
}

function renderCode(lines: string[]): string | null {
  if (!lines[0]?.trimStart().startsWith("```")) return null;
  const body = lines
    .slice(1, lines.at(-1)?.trimStart().startsWith("```") ? -1 : undefined)
    .join("\n");
  return `<pre><code>${escapeHtml(body)}</code></pre>`;
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** GFM pipe tables only — the shape a comparison draft actually produces. */
function renderTable(lines: string[]): string | null {
  if (lines.length < 2) return null;
  if (!lines.every((line) => line.trim().startsWith("|"))) return null;
  if (!/^[\s|:-]+$/.test(lines[1]) || !lines[1].includes("-")) return null;
  const head = tableCells(lines[0])
    .map((cell) => `<th>${renderInline(cell)}</th>`)
    .join("");
  const body = lines
    .slice(2)
    .map(
      (line) =>
        `<tr>${tableCells(line)
          .map((cell) => `<td>${renderInline(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function renderBlock(block: Block): string {
  const { lines } = block;
  const code = renderCode(lines);
  if (code) return code;
  const table = renderTable(lines);
  if (table) return table;
  const list = renderList(lines);
  if (list) return list;
  const quote = renderQuote(lines);
  if (quote) return quote;
  if (lines.length === 1) {
    const heading = renderHeading(lines[0]);
    if (heading) return heading;
  }
  // A run of lines with a heading in it means the writer forgot a blank line;
  // rendering each line on its own beats emitting "## FAQ" as body text.
  if (lines.some((line) => /^#{1,6}\s+/.test(line))) {
    return lines
      .map((line) => renderHeading(line) ?? `<p>${renderInline(line)}</p>`)
      .join("\n");
  }
  return `<p>${renderInline(lines.join(" ").trim())}</p>`;
}

/**
 * The body only — callers strip frontmatter first, because on WordPress the
 * title and description are fields, not text at the top of the post.
 */
export function markdownToHtml(markdown: string): string {
  return blocksOf(markdown)
    .map(renderBlock)
    .filter((html) => html !== "<p></p>")
    .join("\n\n");
}
