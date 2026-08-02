/** The law that catches a machine inventing a credential.
 *
 * This is the one law with no mechanical proxy anywhere else in the table:
 * every other check counts something (words, headings, links, a phrase), and
 * "I have opened enough machines to know" counts perfectly while being false.
 * The real article that prompted this law is the last case in the file. */

import { describe, expect, it } from "vitest";
import { defaultLaws, experienceClaims, validate } from "../src/index.ts";
import type { EngineConfig, Post } from "../src/index.ts";

function post(body: string): Post {
  return {
    slug: "x", title: "T", description: "D", date: "2026-08-01",
    category: "Guides", raw: body, wordCount: 900, keyword: null, minutes: 5,
  };
}

function cfg(ban: boolean): EngineConfig {
  return {
    site: { url: "https://x.example", name: "X", description: "", blogPath: "blog", mode: "markdown" },
    taxonomy: { Guides: "guides" },
    keywords: { positive: [], negative: [], classify: [] },
    laws: { ...defaultLaws(), banExperienceClaims: ban },
  };
}

describe("experienceClaims()", () => {
  it("catches claims of having done or witnessed something", () => {
    for (const s of [
      "I have opened enough machines to know that descaling matters.",
      "I have seen group head screens clogged with white flakes.",
      "I tested five grinders before writing this.",
      "We ran the same shot twenty times.",
      "In my testing the difference was obvious.",
      "In our experience the gasket fails first.",
      "My testing showed a two second delay.",
      "When I measured the flow it dropped.",
      "I've used this machine for a year.",
    ]) {
      expect(experienceClaims(s), s).not.toHaveLength(0);
    }
  });

  it("leaves ordinary first-person voice alone", () => {
    // requireFirstPerson actively wants these sentences, so a law that
    // flagged them would make the two laws unsatisfiable together.
    for (const s of [
      "I find the flat burr cleaner for milk drinks.",
      "I would start with a coarser grind.",
      "My advice is to descale monthly.",
      "I think the honest answer is it depends.",
      "We recommend checking the gasket first.",
      "I recommend a scale with a timer.",
      "Our guide to grinders covers this.",
      "I built this routine around one variable at a time.",
    ]) {
      expect(experienceClaims(s), s).toHaveLength(0);
    }
  });
});

describe("the law, wired", () => {
  const claiming = post("I have opened enough machines to know that descaling is not seasonal.");
  const clean = post("I find descaling matters more than most guides admit.");

  it("is off by default, because a human author may have really tested it", () => {
    expect(validate(cfg(false), [claiming]).map((p) => p.law)).not.toContain(
      "no claimed experience",
    );
  });

  it("fails a machine draft that claims experience when the caller turns it on", () => {
    expect(validate(cfg(true), [claiming]).map((p) => p.law)).toContain(
      "no claimed experience",
    );
  });

  it("passes a draft whose first person is voice rather than evidence", () => {
    expect(validate(cfg(true), [clean]).map((p) => p.law)).not.toContain(
      "no claimed experience",
    );
  });

  it("catches the sentences the first live article actually produced", () => {
    // Verbatim from the 2026-08-01 run on nemotron-3-ultra:free, which passed
    // all 14 laws and still fabricated two credentials.
    const real =
      "By the time you notice, the boiler has already lost efficiency. I have " +
      "opened enough machines to know that descaling is not a seasonal chore. " +
      "In extreme cases the safety valve weeps or the element fails. I have " +
      "seen group head screens clogged with white flakes.";
    expect(experienceClaims(real)).toHaveLength(2);
    expect(validate(cfg(true), [post(real)]).map((p) => p.law)).toContain(
      "no claimed experience",
    );
  });
});
