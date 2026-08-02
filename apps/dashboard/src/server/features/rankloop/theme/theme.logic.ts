// Theme extraction (spec 0030): what your site looks like, derived from
// your site.
//
// Every rule here was written against a real page — productlaunchos.com, a
// 657 KB Framer document — and the obvious implementation gets five things
// wrong on it. Each is called out where it is handled.
//
// The output is a PROPOSAL. Extraction will be roughly 80% right, so every
// token carries a confidence and the UI renders it as an editable swatch. A
// theme that is silently wrong produces a blog that looks *almost* like the
// site, which reads as broken rather than unstyled.

export type Confidence = "high" | "medium" | "low";

export interface Token<T> {
  value: T;
  confidence: Confidence;
  /** What in the page produced this, so the user can disagree with a
   *  reason rather than with a mystery. */
  evidence: string;
}

export interface SiteTheme {
  colors: {
    background: Token<string>;
    foreground: Token<string>;
    accent: Token<string>;
    border: Token<string>;
  };
  fonts: {
    heading: Token<string>;
    body: Token<string>;
  };
  radius: Token<string>;
  containerWidth: Token<string>;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Decode the HTML entities CSS values arrive wrapped in.
 *
 * `--framer-font-family: &quot;Inter&quot;` reaches a naive regex as
 * `&quot`, which then becomes a font stack named "&quot". Decoding first is
 * the difference between reading a value and reading its escaping.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Resolve `var(--name, fallback)` to its fallback.
 *
 * Framer writes `var(--token-a7a6b367-…, rgba(54, 58, 91, 0.18))` — the
 * usable value is the fallback, and an extractor that skips anything
 * containing `var(` throws away most of the page's real colours. Nested
 * fallbacks resolve inside-out.
 */
export function resolveVar(value: string): string | null {
  let current = value.trim();
  for (let depth = 0; depth < 5 && current.startsWith("var("); depth++) {
    const inner = current.slice(4, current.lastIndexOf(")"));
    const comma = splitTopLevel(inner);
    if (comma.length < 2) return null; // var() with no fallback tells us nothing
    current = comma.slice(1).join(",").trim();
  }
  return current.startsWith("var(") ? null : current;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parse a colour to RGB.
 *
 * Handles `rgb()`/`rgba()` as well as hex, because the real page carries 285
 * occurrences of `rgb(0, 153, 255)` against 41 of `#000`. An extractor that
 * only reads hex finds a site's least-used colours and calls them the brand.
 */
export function parseColor(raw: string): Rgb | null {
  const value = decodeEntities(raw).trim().toLowerCase();

  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgbMatch) {
    const parts = splitTopLevel(rgbMatch[1] ?? "")
      .flatMap((p) => p.trim().split(/\s+/))
      .filter((p) => p !== "" && p !== "/");
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) return null;
    const [rn, gn, bn] = [r, g, b].map((n) => Number.parseFloat(n));
    if ([rn, gn, bn].some((n) => n === undefined || Number.isNaN(n))) return null;
    return {
      r: clamp255(rn ?? 0),
      g: clamp255(gn ?? 0),
      b: clamp255(bn ?? 0),
      a: a === undefined ? 1 : clampAlpha(Number.parseFloat(a)),
    };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (!hex) return null;
  const digits = hex[1] ?? "";
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: expandHexDigit(digits[0]),
      g: expandHexDigit(digits[1]),
      b: expandHexDigit(digits[2]),
      a: digits.length === 4 ? expandHexDigit(digits[3]) / 255 : 1,
    };
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** "f" means "ff" in a 3- or 4-digit hex colour. */
const expandHexDigit = (digit: string | undefined) =>
  Number.parseInt((digit ?? "0").repeat(2), 16);

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const clampAlpha = (n: number) => (Number.isNaN(n) ? 1 : Math.max(0, Math.min(1, n)));

const hexPart = (n: number) => n.toString(16).padStart(2, "0");

export function toHex(color: Rgb): string {
  return `#${hexPart(color.r)}${hexPart(color.g)}${hexPart(color.b)}`;
}

/** Perceived brightness, 0–1. The weights are the standard luma
 *  coefficients — green reads brighter than blue at the same value. */
export function luminance(color: Rgb): number {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
}

/** How far from grey, 0–1. Distinguishes a brand colour from a shade of
 *  text: #0099ff is saturated, #363a5b barely is, #ffffff is not at all. */
export function saturation(color: Rgb): number {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  return max === 0 ? 0 : (max - min) / max;
}

// ---------------------------------------------------------------------------
// Harvesting
// ---------------------------------------------------------------------------

export interface ColorCount {
  hex: string;
  color: Rgb;
  count: number;
}

/** Every colour in the document, by how often it appears. Frequency is the
 *  signal — a colour used 285 times is a decision, one used twice is a
 *  one-off. */
export function harvestColors(html: string): ColorCount[] {
  const text = decodeEntities(html);
  const literals = text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)/g) ?? [];
  const counts = new Map<string, ColorCount>();

  for (const literal of literals) {
    const color = parseColor(literal);
    // Fully transparent colours are layout, not palette.
    if (color === null || color.a === 0) continue;
    const hex = toHex(color);
    // Keyed by hex AND alpha, not hex alone.
    //
    // A site's text colour and its border are very often the same RGB at
    // different opacities — on the measured page, rgb(54,58,91) is the text
    // and rgba(54,58,91,0.18) is the border. Keying by hex collapses them
    // into one entry whose alpha is whichever appeared first, after which
    // the two roles can never be told apart and the text colour vanishes
    // from the opaque bucket entirely.
    const key = `${hex}@${color.a.toFixed(2)}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { hex, color, count: 1 });
  }

  return [...counts.values()].toSorted((a, b) => b.count - a.count);
}

const CSS_KEYWORDS = new Set([
  "inherit", "initial", "unset", "revert", "auto", "none", "currentcolor", "transparent",
]);

/**
 * Literal length values for a property, by frequency.
 *
 * Keywords are excluded, and on the real page that is not a nicety:
 * `border-radius: inherit` appears 171 times against 5 real radii, so an
 * extractor that keeps keywords reports the site's corner radius as the word
 * "inherit".
 */
export function harvestLengths(html: string, property: string): { value: string; count: number }[] {
  const text = decodeEntities(html);
  const rx = new RegExp(`${property}\\s*:\\s*([^;}"]{1,40})`, "gi");
  const counts = new Map<string, number>();

  for (const match of text.matchAll(rx)) {
    const raw = (match[1] ?? "").trim();
    const resolved = resolveVar(raw) ?? raw;
    const first = resolved.split(/\s+/)[0]?.trim() ?? "";
    if (first === "" || CSS_KEYWORDS.has(first.toLowerCase())) continue;
    if (!/^-?[\d.]+(px|rem|em|%|vw|vh)$/i.test(first)) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count);
}

/**
 * Font stacks in the document, most used first.
 *
 * The hardest token to extract and the one with the lowest confidence.
 * Framer encodes fonts in a base64 `--font-selector` and leaves
 * `font-family` as a chain of `var()`s pointing at generated token names, so
 * on that page there is often no readable stack at all. Returning nothing is
 * the correct answer when that happens.
 */
export function harvestFonts(html: string): { stack: string; count: number }[] {
  const text = decodeEntities(html);
  const counts = new Map<string, number>();

  for (const match of text.matchAll(/font-family\s*:\s*([^;}]{1,160})/gi)) {
    const raw = (match[1] ?? "").trim();
    const resolved = resolveVar(raw) ?? raw;
    const cleaned = resolved.replace(/["']/g, "").trim();
    // A leftover var() means every fallback was another variable. Nothing
    // readable survives, and inventing a stack here would put a font on the
    // user's blog that appears nowhere on their site.
    if (cleaned === "" || cleaned.includes("var(")) continue;
    if (cleaned.length < 2) continue;
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([stack, count]) => ({ stack, count }))
    .toSorted((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const FALLBACK: SiteTheme = {
  colors: {
    background: { value: "#ffffff", confidence: "low", evidence: "default" },
    foreground: { value: "#111111", confidence: "low", evidence: "default" },
    accent: { value: "#2563eb", confidence: "low", evidence: "default" },
    border: { value: "#e5e7eb", confidence: "low", evidence: "default" },
  },
  fonts: {
    heading: { value: "system-ui, sans-serif", confidence: "low", evidence: "default" },
    body: { value: "system-ui, sans-serif", confidence: "low", evidence: "default" },
  },
  radius: { value: "8px", confidence: "low", evidence: "default" },
  containerWidth: { value: "72ch", confidence: "low", evidence: "default" },
};

function confidenceFor(count: number, total: number): Confidence {
  if (total === 0) return "low";
  if (count >= 20) return "high";
  if (count >= 5) return "medium";
  return "low";
}

/**
 * Assign colour roles.
 *
 * Frequency alone names the wrong things: the most common colour on almost
 * every page is white, so "most frequent" would make white the accent as
 * often as the background. Roles are picked by frequency WITHIN a bucket —
 * lightest, darkest, most saturated — which is what makes the accent an
 * accent rather than whichever neutral happened to win.
 */
export function assignColorRoles(colors: readonly ColorCount[]): SiteTheme["colors"] {
  if (colors.length === 0) return FALLBACK.colors;
  const total = colors.reduce((sum, c) => sum + c.count, 0);
  const opaque = colors.filter((c) => c.color.a >= 0.9);

  const light = opaque.filter((c) => luminance(c.color) >= 0.85);
  const dark = opaque.filter((c) => luminance(c.color) <= 0.35);
  const saturated = opaque.filter(
    (c) => saturation(c.color) >= 0.35 && luminance(c.color) > 0.15 && luminance(c.color) < 0.85,
  );
  // A border is usually a translucent version of the text colour, which is
  // why it is looked for among the semi-transparent values first.
  const translucent = colors.filter((c) => c.color.a < 0.9);

  const pick = (
    list: readonly ColorCount[],
    fallback: Token<string>,
    label: string,
  ): Token<string> => {
    const best = list[0];
    if (!best) return fallback;
    return {
      value: best.hex,
      confidence: confidenceFor(best.count, total),
      evidence: `${label}, used ${best.count} time${best.count === 1 ? "" : "s"}`,
    };
  };

  const background = pick(light, FALLBACK.colors.background, "lightest frequent colour");
  const foreground = pick(dark, FALLBACK.colors.foreground, "darkest frequent colour");
  const accent = pick(saturated, FALLBACK.colors.accent, "most-used saturated colour");
  const border = pick(
    translucent.length > 0 ? translucent : opaque.slice(1),
    FALLBACK.colors.border,
    translucent.length > 0 ? "most-used translucent colour" : "secondary neutral",
  );

  return { background, foreground, accent, border };
}

/**
 * Derive the whole theme from a page's HTML.
 *
 * `pages` rather than one page: a homepage is often the least representative
 * page on a site, and a token that appears on three pages is a system while
 * one that appears on one is a hero section.
 */
export function extractTheme(pages: readonly string[]): SiteTheme {
  const html = pages.join("\n");
  if (html.trim() === "") return FALLBACK;

  const colors = harvestColors(html);
  const fonts = harvestFonts(html);
  const radii = harvestLengths(html, "border-radius");
  const widths = harvestLengths(html, "max-width");

  const bodyFont = fonts[0];
  // Heading and body differ on plenty of sites and are identical on plenty
  // more. The second-most-used stack is the honest guess for a heading, and
  // it falls back to the body stack rather than inventing a pairing.
  const headingFont = fonts[1] ?? fonts[0];

  return {
    colors: assignColorRoles(colors),
    fonts: {
      heading: bodyFont
        ? {
            value: headingFont?.stack ?? bodyFont.stack,
            // Fonts get the lowest ceiling of any token: the value is often
            // hidden behind generated variables, so even a confident-looking
            // count is a weaker claim than a colour's.
            confidence: "low",
            evidence: `font-family declaration, used ${headingFont?.count ?? bodyFont.count} times`,
          }
        : FALLBACK.fonts.heading,
      body: bodyFont
        ? {
            value: bodyFont.stack,
            confidence: "low",
            evidence: `most-used font-family declaration (${bodyFont.count} times)`,
          }
        : FALLBACK.fonts.body,
    },
    radius: radii[0]
      ? {
          value: radii[0].value,
          confidence: confidenceFor(radii[0].count, radii.length),
          evidence: `most-used border-radius (${radii[0].count} times)`,
        }
      : FALLBACK.radius,
    containerWidth: pickContainerWidth(widths) ?? FALLBACK.containerWidth,
  };
}

/**
 * The content column width.
 *
 * Filtered to a readable range: `max-width` is used for icons, avatars and
 * full-bleed sections as much as for prose, so the most frequent value is
 * usually 100% or 24px. Only values a paragraph could plausibly sit in are
 * considered.
 */
function pickContainerWidth(
  widths: readonly { value: string; count: number }[],
): Token<string> | null {
  const readable = widths.filter((w) => {
    const px = /^([\d.]+)px$/.exec(w.value);
    if (!px) return false;
    const n = Number.parseFloat(px[1] ?? "0");
    return n >= 480 && n <= 1400;
  });
  const best = readable[0];
  if (!best) return null;
  return {
    value: best.value,
    confidence: confidenceFor(best.count, readable.length),
    evidence: `most-used content max-width (${best.count} times)`,
  };
}

/** The theme as a stylesheet the scaffold PR writes. */
export function renderThemeCss(theme: SiteTheme): string {
  return [
    "/* Generated by rankloop from your site. Edit freely — rankloop only",
    "   rewrites this file when you ask it to re-extract your theme. */",
    ":root {",
    `  --rl-bg: ${theme.colors.background.value};`,
    `  --rl-fg: ${theme.colors.foreground.value};`,
    `  --rl-accent: ${theme.colors.accent.value};`,
    `  --rl-border: ${theme.colors.border.value};`,
    `  --rl-font-heading: ${theme.fonts.heading.value};`,
    `  --rl-font-body: ${theme.fonts.body.value};`,
    `  --rl-radius: ${theme.radius.value};`,
    `  --rl-container: ${theme.containerWidth.value};`,
    "}",
    "",
  ].join("\n");
}

/** Tokens the user should look at before shipping, worst first. */
export function lowConfidenceTokens(theme: SiteTheme): string[] {
  const entries: [string, Token<string>][] = [
    ["Background", theme.colors.background],
    ["Text", theme.colors.foreground],
    ["Accent", theme.colors.accent],
    ["Border", theme.colors.border],
    ["Heading font", theme.fonts.heading],
    ["Body font", theme.fonts.body],
    ["Corner radius", theme.radius],
    ["Content width", theme.containerWidth],
  ];
  return entries.filter(([, token]) => token.confidence === "low").map(([name]) => name);
}
