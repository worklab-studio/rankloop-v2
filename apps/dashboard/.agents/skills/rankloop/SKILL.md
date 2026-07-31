---
name: rankloop
description: Write the pages rankloop proposed, natively in this repo — pull approved proposals and their briefs over MCP, write in the repo's own stack, grade with rankloop_check until every law passes, open a PR, and report what shipped.
---

# rankloop

## Goal

rankloop holds the judgment. You hold the hands.

rankloop decides what is worth writing and what a published page must survive.
It never writes a word and never calls a model. You write the page, in this
repo, in its stack, with its components — and the source never leaves this
machine. Only the brief comes down the wire and only the verdict goes back up.

## Required inputs

- The rankloop MCP server, connected and signed in (project-scoped: you see
  only the project your token can see).
- A repo that publishes the site — the content tree you are about to add to.
- `projectId`. If you do not have one, `rankloop_status` will not resolve;
  ask the user which project this repo publishes.

## The tools

| Tool                      | What it gives you                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rankloop_status`         | quota for today (including any indexation throttle and why it is on), counts by status, spend to date                            |
| `rankloop_proposals`      | approved proposals waiting to be written, with their evidence and page type                                                      |
| `rankloop_brief`          | the grounded brief for one proposal — the same brief the dashboard renders                                                       |
| `rankloop_check`          | submit a draft, get the law report back as data: every law, pass or fail, with thresholds and the excerpts that failed           |
| `rankloop_publish_report` | tell rankloop what shipped (url, path, commit or PR) — the article goes `published`, the manifest is upserted, the receipt opens |
| `rankloop_receipts`       | measured receipts, so you can see what the writing actually moved                                                                |

`rankloop_check` runs the same engine as the dashboard's own gate and the
`rankloop check` CI command. There is no model behind it, so it costs nothing
and you may call it as many times as it takes.

## First contact (once per repo)

Before writing anything, learn where you are and leave that knowledge in the
repo where the code lives.

### 1. Scaffold

```bash
npx rankloop init
```

It detects the framework and content directory, then writes, never
overwriting:

```text
rankloop.json                     contentDir, blogPath, mode, taxonomy, law overrides
rankloop/writer-prompt.md         voice card + verified-facts contract
rankloop/post-template.md         the structure a post follows
.github/workflows/rankloop-check.yml
```

Re-running reports nothing to do.

### 2. Study the repo

Read before you conclude. Specifically:

- **Framework and content pipeline** — Next/Astro/Hugo/Eleventy/plain
  markdown. Where do posts live, what does frontmatter carry, how is a route
  produced from a file?
- **Components** — the ones existing posts actually use (callouts, figures,
  code blocks, tables, FAQ blocks). A new post that hand-rolls a `<div>` where
  the repo has a component is the tell that a stranger wrote it.
- **CSS tokens** — the design tokens or utility classes in use. Never
  introduce a hex color, a font, or a spacing scale the repo does not already
  have.
- **Existing posts** — read three or four end to end. How long are they, how
  do they open, who is the narrator, what do they never do?

### 3. Write the two files into the repo

Fill in `rankloop/writer-prompt.md` and `rankloop/post-template.md` with what
you found. They are the durable half of this skill: voice and structure belong
beside the code, versioned with it and reviewable in a PR, not re-derived from
scratch in every session.

`rankloop/writer-prompt.md` should carry:

- Who writes here — the narrator, their actual experience, what they have
  personally done with the product or subject.
- The verified-facts contract: what may be asserted, what needs a source, and
  where numbers come from. If a claim cannot be sourced from this repo, the
  brief, or something the user told you, it does not go in the post.
- The words this site never uses, in its own words.

`rankloop/post-template.md` should carry the shape of a post here: the
frontmatter keys and their formats, heading order, where the FAQ goes, how
internal links are written, where images and components sit.

Show the user both files before you commit them. They are describing the
user's own voice, so the user gets the last word on them.

## The routine

Once per writing session:

1. **`rankloop_status`** — how many posts today's quota is asking for, and
   whether an indexation throttle is holding the loop back. If it is, say so
   and stop; writing into a throttle buries the pages you already shipped.
2. **`rankloop_proposals`** — the approved queue. Take them in the order given
   unless the user picks. Each row carries the evidence for why it was
   proposed, and the page type it was proposed as.
3. For each proposal, **`rankloop_brief`** — the keyword, the page type's
   contract, the internal links available to you, and the voice card. Read the
   whole brief before writing a line of the post.
4. **Write the page natively** — in this repo's stack, with the writer prompt
   and the post template open beside the brief. The brief is research and
   constraints: it is not an outline to expand and it is not prose to paste.
   The reader should not be able to tell that a queue existed.
5. **`rankloop_check`** — submit the draft. Read the report. Fix what failed
   and submit again. Repeat until every law passes. Fix the writing, not the
   measurement: a post that reaches the word floor with a padded section has
   passed a law and failed the point of it.
6. **Open a PR.** One post per PR, with the proposal's keyword in the title.
   The scaffolded workflow runs `rankloop check` on the diff, so the same laws
   that just passed locally are the CI status on the PR.
7. **`rankloop_publish_report`** — once the post is actually live: the URL, the
   file path, and the commit or PR. This is what moves the article to
   published, upserts the manifest, and opens the receipt that measures it.

Later, **`rankloop_receipts`** shows what those posts did. Read it before the
next session — it is the only evidence about which of your writing decisions
were right.

## Working alongside the API writer

A project can have rankloop draft some posts and you write others; the mode is
a per-project setting in the dashboard. One queue, one gate, one receipts
view. If a proposal already has a draft against it, leave it alone — it is
being written on the other side.

## Output format

Report per session, one line per proposal:

| Keyword | Page type | Laws | PR  | Reported |
| ------- | --------- | ---: | --- | -------- |

Then:

- What you shipped, and where each post lives in the tree.
- Any law that took more than one pass, and what the fix actually was — that
  is the part worth remembering next session.
- What you did not write, and why.

## Guardrails

- **Never invent a fact, a number, a quote, or a source.** If the brief does
  not ground it and the repo does not contain it, ask the user or leave it
  out. This is the whole reason the writing is yours: a model with no stake in
  the site will fill a gap rather than admit one.
- **The check is the judge, not your reading of it.** Do not argue with a
  failed law by re-explaining the draft; change the draft.
- **Never report a post that is not live.** `rankloop_publish_report` opens a
  receipt that starts measuring a URL. Reporting an unmerged PR produces a
  receipt measuring a 404.
- **Never merge your own PR** unless the user asks. rankloop stops at the
  proposal; you stop at the PR.
- **Do not edit the laws to make a draft pass.** `rankloop.json` law overrides
  belong to the user and describe the site, not this post.
- Internal links must point at pages that exist in this repo. The check will
  catch a dead one, but it is faster to link from the brief's list.
