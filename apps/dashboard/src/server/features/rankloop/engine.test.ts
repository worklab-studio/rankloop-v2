/** Smoke test for the bundled @rankloop/engine dependency (spec 0009, S0).
 *
 * The engine is linked from the monorepo's packages/engine and consumed
 * through its tsup dist build, so this asserts two things at once: the
 * bundle resolves inside this app's toolchain, and the code inside it is
 * the parity-tested engine — the scorer reproduces a fixture value and the
 * publish laws run end to end on a markdown post.
 */

import { defaultLaws, parseMdPost, score, validate } from "@rankloop/engine";
import type { EngineConfig } from "@rankloop/engine";
import { describe, expect, it } from "vitest";

const cfg: EngineConfig = {
  site: {
    url: "https://example.com",
    name: "Example",
    description: "An example site",
    blogPath: "blog",
    mode: "markdown",
  },
  taxonomy: { Guides: "guides" },
  keywords: { positive: [], negative: [], classify: [] },
  // Thresholds sized to the tiny post below; everything else keeps the
  // engine defaults (banned phrases, em-dash ban, first-person law).
  laws: {
    ...defaultLaws(),
    wordMin: 40,
    h2Min: 2,
    faqMin: 1,
    internalLinksMin: 1,
  },
};

const raw = `---
title: How to dial in espresso at home
description: A short guide to dialing in shots on a home machine.
date: 2026-07-01
category: Guides
keyword: espresso
---

I measured every espresso shot for a week to get this method right.

## Getting the grind right

Start coarse and tighten until the shot runs about thirty seconds. Small
changes matter more than big ones, so adjust one notch at a time.

## Why does my shot taste sour?

Sour usually means under-extraction. Grind finer, raise the water
temperature, or both. The [guides hub](/blog/guides/) collects the rest.
`;

describe("@rankloop/engine (bundled)", () => {
  it("reproduces the parity scorer value", () => {
    // log10(5400 + 10) x ((100 - 30) / 50) x 1.3, rounded to 3 places —
    // the same value the engine's own parity fixtures pin against Python.
    expect(score(5400, 30, "commercial")).toBe(6.794);
  });

  it("passes a compliant markdown post through the publish laws", () => {
    const post = parseMdPost("dialing-in-espresso", raw);
    expect(validate(cfg, [post])).toEqual([]);
  });

  it("flags the em dash law when one sneaks in", () => {
    const post = parseMdPost(
      "dialing-in-espresso",
      raw.replace("thirty seconds", "thirty seconds — give or take"),
    );
    expect(validate(cfg, [post])).toEqual([
      { slug: "dialing-in-espresso", law: "em dash" },
    ]);
  });
});
