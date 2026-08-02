// The repair payload: a law report turned into the argument the fix call
// makes (spec 0020). Pure — a report in, a structured payload and its rendered
// message out, no I/O and no model.
//
// This is the file that keeps the fix honest. A failing draft is never "asked
// nicely to be better" by a second model acting as judge; it is handed the
// specific laws it broke, the bar each one sets, and its own offending
// sentences, plus one standing instruction: change what the violations require
// and nothing else. There is no sentence anywhere in here that asks a model
// for an opinion about quality.

import type { LawExcerpt, LawId, LawReport, LawVerdict } from "./gate";

/** One violated law, as the fix call receives it. */
export type RepairViolation = {
  id: LawId;
  /** The engine's own law name, verbatim, so the writer and the report agree. */
  law: string;
  threshold: string | null;
  observed: string | null;
  /** What to change, in this law's terms. */
  fix: string;
  /** Every offending quote the gate found, up to its cap. The stored report
   *  keeps only the first; a fix call can act on all of them at once. */
  excerpts: LawExcerpt[];
};

export type RepairPayload = {
  /** The rule that makes a fix a fix and not a second draft. */
  instruction: string;
  violations: RepairViolation[];
};

/**
 * The standing instruction.
 *
 * Every law this draft already passed is a law a rewrite can break, and the
 * attempt budget is three: a fix that re-earns ground it already held spends a
 * whole attempt standing still. The last line is the honesty contract carried
 * forward, because a word-count violation is exactly where a writer starts
 * inventing a benchmark to fill the gap.
 */
const INSTRUCTION = [
  "Fix only what the violations below require.",
  "Leave every other sentence exactly as it is: the draft already passed the",
  "rest of the laws, and rewriting a passing section puts it back at risk.",
  "Return the complete document, frontmatter and body, in the same shape you",
  "were asked for the first time. Do not invent facts, numbers, quotes or",
  "testing to satisfy a law.",
].join(" ");

/**
 * What to do about each law, written for the writer rather than for the UI.
 *
 * Deliberately free of em dashes: the em-dash ban is one of the laws being
 * enforced, and a writer mirrors the punctuation of the document it is handed.
 */
const FIX_BY_LAW: Readonly<Record<LawId, string>> = {
  emDash:
    "Remove every em dash. Rewrite with a comma, a colon, or two shorter " +
    "sentences. Substituting a hyphen or an en dash is not a fix.",
  canonical:
    "The canonical link has to point at this post's own URL, exactly as the " +
    "site serves it.",
  categoryKnown:
    "Set the category to one of the site's approved page types, spelled " +
    "exactly as listed in the threshold.",
  titleMax:
    "Shorten the title to fit. Keep the keyword in it; drop the qualifier, " +
    "not the subject.",
  descriptionMax:
    "Shorten the description to one sentence that still says what the page " +
    "answers.",
  dateParses: "Write the date as YYYY-MM-DD and nothing else.",
  wordMin:
    "The body is under the floor. Add substance the brief already grounds: " +
    "another section, a worked step, an objection you can answer. Do not pad " +
    "and do not invent facts to reach the number.",
  wordMax:
    "The body is over the ceiling. Cut restatement and preamble first, then " +
    "any section that repeats a point another one already made.",
  h2Min:
    "Add H2 sections until the body has enough of them. Each one has to " +
    "carry its own point; splitting an existing section in half is not a new " +
    "section.",
  faqMin:
    "Add question-shaped H2 headings, in the words someone would actually " +
    "search, with a direct answer in the first sentence under each.",
  internalLinksMin:
    "Link only to the pages the brief listed as candidates, using the exact " +
    "paths it gave. Any other path does not exist on this site, and a link " +
    "to a page that is not there is worse than no link.",
  keywordInBody:
    "Use the keyword verbatim in the body at least once, in a sentence where " +
    "it belongs.",
  keywordDensityMax:
    "The keyword is repeated too often for the length of the piece. Cut the " +
    "repetitions and use natural variations instead.",
  bannedPhrases:
    "Delete these phrases and say the thing plainly. Rewrite the sentence " +
    "around each one: removing the words alone leaves the same empty shape.",
  firstPerson:
    "Nothing in the piece is written in first person. Say what you did, " +
    "built, checked or would check, in your own voice. Do not invent a test " +
    "you did not run.",
  experienceClaims:
    "These sentences claim you did or saw something. You did not: you are " +
    "writing from the brief. Keep the first-person voice and drop the " +
    "credential. \"I have opened enough machines to know X\" becomes \"X\", " +
    "or \"most machines show X\" if the brief supports it. Do not swap one " +
    "invented experience for a vaguer one.",
  unknown:
    "This build has no guidance for this law. Its name states the " +
    "requirement; satisfy it without changing anything else.",
};

/**
 * The violated laws as data.
 *
 * Passing laws are dropped here and only here: the stored report keeps them
 * (it is the receipt), while the fix call gets the failures, because listing
 * thirteen satisfied laws in a prompt is thirteen invitations to touch them.
 */
export function buildRepairPayload(report: LawReport): RepairPayload {
  return {
    instruction: INSTRUCTION,
    violations: report.laws
      .filter((verdict) => !verdict.passed)
      .map(toViolation),
  };
}

function toViolation(verdict: LawVerdict): RepairViolation {
  return {
    id: verdict.id,
    law: verdict.law,
    threshold: verdict.threshold,
    observed: verdict.observed,
    fix: FIX_BY_LAW[verdict.id],
    excerpts: verdict.excerpts,
  };
}

/**
 * The payload as the message a fix call carries.
 *
 * Rendering lives with the payload rather than with the provider call so that
 * what the writer is told is testable without a key, and so the wording of a
 * law's fix changes in exactly one place.
 */
export function renderRepairPayload(payload: RepairPayload): string {
  const count = payload.violations.length;
  if (count === 0) {
    return "This draft cleared every law. There is nothing to fix.";
  }

  const sections = payload.violations.map((violation, index) =>
    renderViolation(violation, index + 1),
  );
  return [
    `This draft did not clear the publish laws. ${count} law${
      count === 1 ? "" : "s"
    } failed; everything else passed.`,
    "",
    payload.instruction,
    "",
    ...sections,
  ].join("\n");
}

function renderViolation(violation: RepairViolation, position: number): string {
  const lines = [`## ${position}. ${violation.law}`];
  if (violation.threshold !== null) {
    lines.push(`Required: ${violation.threshold}`);
  }
  if (violation.observed !== null) {
    lines.push(`In your draft: ${violation.observed}`);
  }
  lines.push(`Fix: ${violation.fix}`);
  if (violation.excerpts.length > 0) {
    lines.push("Offending text:");
    for (const excerpt of violation.excerpts) {
      lines.push(`- ${excerpt.label}: ${JSON.stringify(excerpt.quote)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
