import { describe, expect, it } from "vitest";
import {
  kitGaps,
  kitIsUsable,
  renderPayload,
  truncateAtWord,
  type SubmissionKit,
} from "./submission-kit";

function kit(over: Partial<SubmissionKit> = {}): SubmissionKit {
  return {
    name: "Rankloop",
    tagline: "The open-source SEO engine that publishes to your own repo",
    shortDescription:
      "Rankloop studies your site, plans what to publish, gates every draft against machine-checkable laws, and measures what it moved.",
    longDescription: "A ".repeat(400),
    url: "https://rankloop.dev",
    logoUrl: null,
    categories: ["SEO", "Developer tools"],
    pricing: "Open source",
    founder: null,
    launchDate: null,
    ...over,
  };
}

describe("truncateAtWord()", () => {
  it("leaves text under the limit alone", () => {
    expect(truncateAtWord("short enough", 50)).toBe("short enough");
  });

  it("never cuts a word in half", () => {
    // A description ending "the fastest way to publ" is how a submission
    // goes out looking abandoned.
    const out = truncateAtWord("the fastest way to publish programmatic pages", 25);
    expect(out.endsWith("publ")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.split(" ").at(-1)).toBe("to");
  });

  it("drops punctuation left dangling by the cut", () => {
    expect(truncateAtWord("one, two, three, four", 10)).toBe("one, two");
  });

  it("adds no ellipsis", () => {
    // Directories count characters. Spending three of them on punctuation
    // that says "there was more" helps nobody.
    expect(truncateAtWord("a much longer sentence than the limit", 12)).not.toContain(
      "…",
    );
  });

  it("hard-cuts when the first word is itself too long", () => {
    const out = truncateAtWord("supercalifragilistic", 8);
    expect(out).toHaveLength(8);
  });

  it("handles an empty string", () => {
    expect(truncateAtWord("   ", 10)).toBe("");
  });
});

describe("renderPayload()", () => {
  it("fits each field to the target's limit", () => {
    const fields = renderPayload(kit(), { tagline: 30, shortDescription: 80 });
    const tagline = fields.find((f) => f.label === "Tagline");
    expect(tagline?.value.length).toBeLessThanOrEqual(30);
    expect(tagline?.truncated).toBe(true);
  });

  it("says when it shortened something", () => {
    // The user is about to paste this into a form. If we quietly cut their
    // description they find out when somebody reads the listing.
    const fields = renderPayload(kit(), { shortDescription: 40 });
    expect(fields.find((f) => f.label === "Short description")?.truncated).toBe(true);
  });

  it("does not claim truncation when nothing was cut", () => {
    const fields = renderPayload(kit({ tagline: "Short" }), { tagline: 60 });
    expect(fields.find((f) => f.label === "Tagline")?.truncated).toBe(false);
  });

  it("treats an unlimited field as unlimited, not zero-length", () => {
    // The bug this guards: `limits.tagline ?? 0` would render every tagline
    // as an empty string on any target that does not state a limit.
    const fields = renderPayload(kit());
    expect(fields.find((f) => f.label === "Name")?.value).toBe("Rankloop");
    expect(fields.find((f) => f.label === "Name")?.limit).toBeNull();
  });

  it("omits empty optional fields instead of rendering blanks", () => {
    const fields = renderPayload(kit({ logoUrl: null, founder: null }));
    expect(fields.map((f) => f.label)).not.toContain("Logo");
    expect(fields.map((f) => f.label)).not.toContain("Founder");
  });

  it("includes optional fields once they are filled", () => {
    const fields = renderPayload(
      kit({ logoUrl: "https://rankloop.dev/logo.png", founder: "Deepak" }),
    );
    expect(fields.map((f) => f.label)).toContain("Logo");
    expect(fields.map((f) => f.label)).toContain("Founder");
  });

  it("joins categories the way a form expects", () => {
    const fields = renderPayload(kit());
    expect(fields.find((f) => f.label === "Categories")?.value).toBe(
      "SEO, Developer tools",
    );
  });
});

describe("kitGaps()", () => {
  it("names what is still missing, as sentences", () => {
    expect(kitGaps({})).toEqual([
      "a product name",
      "a one-line tagline",
      "a short description",
      "your product URL",
    ]);
  });

  it("does not block on fields most forms treat as optional", () => {
    // A long description and a logo are frequently optional on the form
    // itself; refusing to render a payload without them would stop a
    // submission that would have gone through.
    expect(
      kitIsUsable({
        name: "Rankloop",
        tagline: "x",
        shortDescription: "y",
        url: "https://rankloop.dev",
      }),
    ).toBe(true);
  });

  it("treats whitespace as missing", () => {
    expect(kitGaps({ name: "   " })).toContain("a product name");
  });
});
