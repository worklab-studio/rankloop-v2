/** What `init` writes into a repository.
 *
 * Four files, and the split between them is deliberate. rankloop.json is
 * machine-read config. writer-prompt.md and post-template.md are read by
 * whatever writes the posts — an agent, or a person — and they live in the
 * repo rather than in a dashboard because the voice and the structure belong
 * next to the code that renders them. The workflow is where the laws become a
 * merge gate, which is the only place a quality bar actually holds — see
 * `workflow()` for why it is scaffolded switched off.
 *
 * The law values in the scaffolded config are generated from the engine's own
 * `defaultLaws()`, so the file a user reads can never drift from the
 * thresholds the check enforces. */

import { defaultLaws } from "@rankloop/engine";
import type { Detection } from "./detect.ts";
import { VERSION } from "./version.ts";

export interface ScaffoldInput {
  detection: Detection;
  contentDir: string;
  siteUrl: string;
  siteName: string;
}

// ---------------------------------------------------------------------------
// rankloop.json
// ---------------------------------------------------------------------------

export function rankloopJson(input: ScaffoldInput): string {
  const laws = defaultLaws();
  const config = {
    "//": [
      "rankloop config: the whole site in one file.",
      "`rankloop check` reads this, reads contentDir, and enforces the laws below.",
      "Every law is optional; delete one to inherit the engine's default.",
    ].join(" "),
    site: {
      url: input.siteUrl,
      name: input.siteName,
      description: "One sentence a stranger could repeat back to you.",
      blogPath: input.detection.blogPath,
      mode: input.detection.mode,
    },
    contentDir: input.contentDir,
    "//taxonomy": "Display category -> hub slug. The category law checks a post against these keys.",
    taxonomy: {
      Guides: "guides",
      Comparisons: "compare",
    },
    "//laws":
      "bannedPhrases defaults to the engine's calibrated list; set it here only to replace that list wholesale.",
    laws: {
      wordMin: laws.wordMin,
      wordMax: laws.wordMax,
      h2Min: laws.h2Min,
      faqMin: laws.faqMin,
      internalLinksMin: laws.internalLinksMin,
      titleMax: laws.titleMax,
      descriptionMax: laws.descriptionMax,
      keywordDensityMax: laws.keywordDensityMax,
      banEmDash: laws.banEmDash,
      requireFirstPerson: laws.requireFirstPerson,
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// rankloop/writer-prompt.md
// ---------------------------------------------------------------------------

/** The voice card plus the verified-facts contract: the standing rules that
 * never change between posts. A brief carries the per-keyword grounding; this
 * carries who the site sounds like and what it is allowed to assert without a
 * source. Ported from the v1 template and pointed at the repo, because that is
 * where an agent doing the writing already is. */
export function writerPrompt(input: ScaffoldInput): string {
  return `# Writer prompt

The standing rules for every post on this site. A rankloop brief carries the
per-keyword grounding (the keyword, what currently ranks, the real questions,
the laws with exact thresholds, the pages you may link to). This file carries
what does not change: the voice, the structure, and what you are allowed to
claim. A human writer can read it top to bottom as a style guide. It is the
same contract either way.

Everything you write is machine-checked by \`rankloop check\` and rejected on
any failure, so treat the laws as hard constraints, not suggestions.

## This repo

- Framework: ${input.detection.label}
- Posts live in: \`${input.contentDir}\`
- Posts are served under: \`/${input.detection.blogPath}/<slug>/\`

Write the page **natively in this stack**: its components, its frontmatter
fields, its conventions. Read two existing posts before you write a new one.
A post that needs a new component is fine. A post that needs a new pattern
nobody else in the repo uses is a post fighting the codebase.

## The angle

Read what currently ranks, in the brief, and find what it underserves: the
missing number, the unanswered follow-up, the honest downside nobody states,
the comparison nobody dares make. That gap is the post. If the top results
already answer the query completely and you have nothing to add, say so
instead of writing the eleventh copy of the same page.

## Structure

- The lede answers the query in the first 40 to 60 words. That paragraph is
  what search snippets and answer engines quote. Write it to be lifted.
- Descriptive H2 sections. Vary their internal shape; identically-shaped
  sections are a mass-production tell.
- At least one data table IF there is real data to put in it. Never invent a
  table to satisfy a shape.
- FAQ: the real questions from the brief, answered in your own words.
- Internal links only to pages the brief lists. Anchor text says what the
  reader gets, never "click here".

## Voice

<!-- EDIT ME: replace this block with how this site actually sounds. Two or
     three lines, and one sentence you would never write. -->

- First person where it is genuine. One specific author, not "we here at".
- Plain declarative sentences. If a sentence works without its opening
  clause, cut the clause.
- No em dashes. Colons, commas, periods.
- Nothing that would fit in any article on any topic.

## Verified facts

<!-- EDIT ME: the facts about this product or site a writer may state without
     a source. What it is, what it actually does, how it is licensed, who
     writes here. Keep it short and TRUE: this list is the only unsourced
     material a writer is allowed to assert. -->

- (your verified facts here)

## Honesty

- No fabricated benchmarks, statistics, reviews, quotes or user counts. Every
  number needs a source you were given or a measurement you actually have.
  No source, no number.
- Describe pricing models, not dollar amounts, unless the brief supplies a
  current price.
- Credit competitors fairly and label your bias when comparing your own
  product. A comparison that always wins is an ad, and readers know it.
- Never claim testing you did not do. "I have not tested this" is a
  publishable sentence.
`;
}

// ---------------------------------------------------------------------------
// rankloop/post-template.md
// ---------------------------------------------------------------------------

/** The structure a post follows. Deliberately a filled-in shape rather than a
 * blank one: the frontmatter keys are exactly what the engine's markdown
 * parser reads, and getting one of them wrong fails four laws at once for a
 * reason that has nothing to do with the writing. */
export function postTemplate(input: ScaffoldInput): string {
  const laws = defaultLaws();
  return `---
title: At most ${laws.titleMax} characters, and it says what the page answers
description: At most ${laws.descriptionMax} characters. The sentence a search result shows.
date: YYYY-MM-DD
category: Guides
keyword: the exact primary keyword from the brief
---

The lede: answer the query in the first 40 to 60 words, before any setup. No
"in this guide", no throat-clearing. State the answer, then earn the rest.

## A descriptive H2, not "Introduction"

The body. At least ${laws.wordMin} words across the whole post, at most
${laws.wordMax}. First person where it is genuine.

Link to real pages only, at least ${laws.internalLinksMin} of them:
[what the reader gets](/${input.detection.blogPath}/an-existing-slug/).

## The second section

## The third section

## The fourth section

<!-- ${laws.h2Min} H2 sections minimum, including the FAQ questions below. -->

## Frequently asked questions

### Is this a real question someone asked?

A direct answer in two or three sentences. The FAQ law counts question-shaped
headings, so the question mark is load-bearing: at least ${laws.faqMin} of them.

### What if the honest answer is no?

Then say no. A page that admits a limit is the one people cite.

### How do I know this passes?

Run \`rankloop check\`. It prints every law it broke, with the file and line.
`;
}

// ---------------------------------------------------------------------------
// .github/workflows/rankloop-check.yml
// ---------------------------------------------------------------------------

/** The version is pinned, not floated. A gate that can change its mind
 * between two runs of the same commit is not a gate; upgrading is a one-line
 * diff a reviewer can see.
 *
 * The gate ships INACTIVE, and that is the honest state of things: `rankloop`
 * is not on npm yet, so an enabled `npx rankloop@<version>` would fail on the
 * very first pull request of a repo somebody just scaffolded. A gate that is
 * red before anyone wrote a post is one people learn to click past, which
 * costs more than the week of not having it. So the job runs, says out loud
 * that it is not judging anything, and leaves the real step one uncomment
 * away. `init`'s next-steps output says the same thing on the terminal. */
export function workflow(input: ScaffoldInput): string {
  return `name: rankloop check

# The publish laws as a merge gate. This job needs no API key, no rankloop
# account and no network: the engine is MIT and runs offline. Whichever writer
# produced the post, nothing merges that breaks the laws.
#
# NOT ENABLED YET: rankloop ${VERSION} is not published to npm, so the check
# step below is commented out rather than failing every pull request. Run
# \`rankloop check\` locally in the meantime — same binary, same laws, same exit
# code. When the package ships, delete the notice step and uncomment the run
# under it; that is the whole change.

on:
  pull_request:
    paths:
      - "${input.contentDir}/**"
      - "rankloop.json"
  push:
    branches: [main]

jobs:
  laws:
    name: publish laws
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: laws not enforced yet
        run: |
          echo "::notice::rankloop ${VERSION} is not on npm yet, so the publish laws are NOT gating this pull request. Run 'rankloop check' locally, and uncomment the step in .github/workflows/rankloop-check.yml once the package ships."
      # --format=github turns each violation into an annotation, so a failure
      # lands on the offending line of the diff instead of in the log tail.
      # - run: npx rankloop@${VERSION} check --format=github
`;
}
