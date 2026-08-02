// Every case here is one the obvious implementation gets wrong on a real
// page. The fixtures are the actual patterns measured on productlaunchos.com
// (Framer, 657 KB) — see spec 0030.

import { describe, expect, it } from "vitest";
import {
  assignColorRoles,
  decodeEntities,
  extractTheme,
  harvestColors,
  harvestFonts,
  harvestLengths,
  lowConfidenceTokens,
  luminance,
  parseColor,
  renderThemeCss,
  resolveVar,
  saturation,
  toHex,
} from "./theme.logic";

describe("decodeEntities()", () => {
  it("unwraps the escaping CSS values arrive in", () => {
    // `--framer-font-family: &quot;Inter&quot;` reaches a naive regex as
    // `&quot`, which becomes a font stack literally named "&quot".
    expect(decodeEntities("&quot;Inter&quot;, sans-serif")).toBe('"Inter", sans-serif');
    expect(decodeEntities("&#39;Inter&#39;")).toBe("'Inter'");
  });
});

describe("resolveVar()", () => {
  it("resolves to the fallback, which is where the real value lives", () => {
    // Framer's actual shape. Skipping anything containing `var(` throws away
    // most of the page's colours.
    expect(resolveVar("var(--token-a7a6b367-a6a6, rgba(54, 58, 91, 0.18))")).toBe(
      "rgba(54, 58, 91, 0.18)",
    );
  });

  it("resolves nested fallbacks inside-out", () => {
    expect(resolveVar("var(--a, var(--b, #363a5b))")).toBe("#363a5b");
  });

  it("returns null when every fallback is another variable", () => {
    // Nothing readable survives. Inventing a value here would put a colour
    // on the user's blog that appears nowhere on their site.
    expect(resolveVar("var(--framer-font-family)")).toBeNull();
  });

  it("passes a plain value straight through", () => {
    expect(resolveVar("12px")).toBe("12px");
  });
});

describe("parseColor()", () => {
  it("reads rgb(), which is what the real page actually uses", () => {
    // 285 occurrences of rgb(0, 153, 255) against 41 of #000. A hex-only
    // extractor finds a site's least-used colours and calls them the brand.
    expect(parseColor("rgb(0, 153, 255)")).toEqual({ r: 0, g: 153, b: 255, a: 1 });
    expect(toHex(parseColor("rgb(0, 153, 255)")!)).toBe("#0099ff");
  });

  it("reads rgba() with its alpha", () => {
    expect(parseColor("rgba(54, 58, 91, 0.18)")).toEqual({ r: 54, g: 58, b: 91, a: 0.18 });
  });

  it("reads hex in every length", () => {
    expect(toHex(parseColor("#000")!)).toBe("#000000");
    expect(toHex(parseColor("#363a5b")!)).toBe("#363a5b");
    expect(parseColor("#363a5b80")?.a).toBeCloseTo(0.5, 1);
  });

  it("reads modern slash-alpha syntax", () => {
    expect(parseColor("rgb(0 153 255 / 0.5)")).toMatchObject({ r: 0, g: 153, b: 255 });
  });

  it("returns null rather than a wrong colour", () => {
    expect(parseColor("inherit")).toBeNull();
    expect(parseColor("var(--x)")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });
});

describe("luminance() and saturation()", () => {
  it("separates a brand colour from a shade of text", () => {
    // #0099ff is saturated, #363a5b barely, #ffffff not at all. This is what
    // stops the accent being whichever neutral happened to win on count.
    expect(saturation(parseColor("#0099ff")!)).toBeGreaterThan(0.9);
    expect(saturation(parseColor("#363a5b")!)).toBeLessThan(0.5);
    expect(saturation(parseColor("#ffffff")!)).toBe(0);
  });

  it("ranks brightness the way an eye does", () => {
    expect(luminance(parseColor("#ffffff")!)).toBeCloseTo(1, 2);
    expect(luminance(parseColor("#000000")!)).toBe(0);
    // Green reads brighter than blue at the same value.
    expect(luminance(parseColor("#00ff00")!)).toBeGreaterThan(
      luminance(parseColor("#0000ff")!),
    );
  });
});

describe("harvestColors()", () => {
  const REAL = `
    <style>
      .a { color: rgb(0, 153, 255); border-color: rgba(54, 58, 91, 0.18); }
      .b { color: rgb(0, 153, 255); background: rgb(255, 255, 255); }
      .c { color: rgb(0, 153, 255); background: #363a5b; }
      .d { outline: 1px solid transparent; }
    </style>`;

  it("counts frequency, because frequency is the signal", () => {
    const colors = harvestColors(REAL);
    expect(colors[0]).toMatchObject({ hex: "#0099ff", count: 3 });
  });

  it("mixes rgb and hex into one tally", () => {
    expect(harvestColors(REAL).map((c) => c.hex)).toContain("#363a5b");
  });

  it("drops fully transparent colours, which are layout not palette", () => {
    expect(harvestColors('<i style="color: rgba(0,0,0,0)"></i>')).toHaveLength(0);
  });

  it("decodes entities before parsing", () => {
    expect(harvestColors("color: &quot;#0099ff&quot;")[0]?.hex).toBe("#0099ff");
  });
});

describe("harvestLengths()", () => {
  it("excludes keywords, which outnumber real values 171 to 5", () => {
    // Without this the site's corner radius is reported as the word
    // "inherit".
    const html = `${"border-radius: inherit;".repeat(171)} border-radius: 12px; border-radius: 12px; border-radius: 8px;`;
    const radii = harvestLengths(html, "border-radius");
    expect(radii.map((r) => r.value)).not.toContain("inherit");
    expect(radii[0]).toEqual({ value: "12px", count: 2 });
  });

  it("resolves var() before deciding", () => {
    expect(
      harvestLengths("border-radius: var(--x, 16px);", "border-radius")[0]?.value,
    ).toBe("16px");
  });

  it("takes the first value of a shorthand", () => {
    expect(
      harvestLengths("border-radius: 12px 4px 12px 4px;", "border-radius")[0]?.value,
    ).toBe("12px");
  });
});

describe("harvestFonts()", () => {
  it("returns nothing when every fallback is a variable", () => {
    // Framer's real shape. Returning nothing is the correct answer — the
    // alternative is a font on the blog that appears nowhere on the site.
    const framer =
      "font-family: var(--framer-font-family); font-family: var(--framer-link-font-family, var(--framer-font-family));";
    expect(harvestFonts(framer)).toHaveLength(0);
  });

  it("reads a readable stack and strips its quotes", () => {
    expect(
      harvestFonts('font-family: &quot;Inter&quot;, system-ui, sans-serif;')[0]?.stack,
    ).toBe("Inter, system-ui, sans-serif");
  });

  it("resolves a var() with a readable fallback", () => {
    expect(harvestFonts("font-family: var(--x, Inter, sans-serif);")[0]?.stack).toBe(
      "Inter, sans-serif",
    );
  });
});

describe("assignColorRoles()", () => {
  // The real palette measured on productlaunchos.com.
  const PALETTE = harvestColors(`
    ${"color: rgb(0, 153, 255);".repeat(285)}
    ${"border-color: rgba(54, 58, 91, 0.18);".repeat(85)}
    ${"background: rgb(255, 255, 255);".repeat(68)}
    ${"color: rgb(85, 97, 200);".repeat(58)}
    ${"color: rgb(54, 58, 91);".repeat(55)}
    ${"background: rgb(250, 251, 255);".repeat(46)}
  `);

  it("does not make white the accent just because it is frequent", () => {
    // The whole reason roles are picked within a bucket. "Most frequent"
    // makes white the accent as often as the background.
    const roles = assignColorRoles(PALETTE);
    expect(roles.accent.value).not.toBe("#ffffff");
    expect(roles.accent.value).toBe("#0099ff");
  });

  it("finds the background among the light colours", () => {
    expect(assignColorRoles(PALETTE).background.value).toBe("#ffffff");
  });

  it("keeps the same RGB at two opacities as two colours", () => {
    // The measured page uses rgb(54,58,91) for text and rgba(54,58,91,0.18)
    // for borders. Collapsing them by hex loses the text colour entirely.
    const both = PALETTE.filter((c) => c.hex === "#363a5b");
    expect(both).toHaveLength(2);
    expect(both.map((c) => c.color.a).toSorted((x, y) => x - y)).toEqual([0.18, 1]);
  });

  it("finds the text colour among the dark ones", () => {
    expect(assignColorRoles(PALETTE).foreground.value).toBe("#363a5b");
  });

  it("prefers a translucent colour for the border", () => {
    // A border is usually a translucent version of the text colour.
    expect(assignColorRoles(PALETTE).border.value).toBe("#363a5b");
  });

  it("carries evidence for every role", () => {
    for (const token of Object.values(assignColorRoles(PALETTE))) {
      expect(token.evidence.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(token.confidence);
    }
  });

  it("falls back rather than throwing on an empty page", () => {
    const roles = assignColorRoles([]);
    expect(roles.background.confidence).toBe("low");
    expect(roles.background.evidence).toBe("default");
  });
});

describe("extractTheme()", () => {
  const PAGE = `
    <style>
      ${"color: rgb(0, 153, 255);".repeat(30)}
      ${"background: rgb(255, 255, 255);".repeat(30)}
      ${"color: rgb(54, 58, 91);".repeat(30)}
      ${"border-radius: inherit;".repeat(100)}
      ${"border-radius: 12px;".repeat(6)}
      ${"max-width: 24px;".repeat(40)}
      ${"max-width: 1200px;".repeat(9)}
      ${"font-family: Inter, sans-serif;".repeat(10)}
    </style>`;

  it("derives a whole theme from one page", () => {
    const theme = extractTheme([PAGE]);
    expect(theme.colors.accent.value).toBe("#0099ff");
    expect(theme.radius.value).toBe("12px");
    expect(theme.fonts.body.value).toBe("Inter, sans-serif");
  });

  it("ignores max-widths no paragraph could sit in", () => {
    // `max-width` is used for icons and avatars as much as for prose, so the
    // most frequent value is usually 24px or 100%.
    expect(extractTheme([PAGE]).containerWidth.value).toBe("1200px");
  });

  it("never reports a font above low confidence", () => {
    // The value is often hidden behind generated variables, so even a
    // confident-looking count is a weaker claim than a colour's.
    const theme = extractTheme([PAGE]);
    expect(theme.fonts.body.confidence).toBe("low");
    expect(theme.fonts.heading.confidence).toBe("low");
  });

  it("returns the fallback theme for an empty site rather than throwing", () => {
    const theme = extractTheme([""]);
    expect(theme.colors.background.value).toBe("#ffffff");
    expect(lowConfidenceTokens(theme)).toHaveLength(8);
  });

  it("names what the user should check", () => {
    expect(lowConfidenceTokens(extractTheme([PAGE]))).toContain("Body font");
  });
});

describe("renderThemeCss()", () => {
  it("emits custom properties the scaffold can use", () => {
    const css = renderThemeCss(extractTheme(["color: rgb(0, 153, 255);".repeat(30)]));
    expect(css).toContain("--rl-accent: #0099ff;");
    expect(css).toContain(":root {");
  });

  it("says it is safe to edit", () => {
    // "rankloop only edits a block it created" — the file has to say which
    // block that is, or a user will not touch it.
    expect(renderThemeCss(extractTheme(["x"]))).toContain("Edit freely");
  });
});
