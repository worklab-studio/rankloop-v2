/** Prompt composition and draft recovery.
 *
 * The brief is the product (source repo hard rule 7); this file only frames
 * it for a CLI and cleans up what comes back. What the model returns is
 * data, not obedience — recovering a file it wrapped in fences is cheaper
 * than a retry, and a retry over formatting teaches the user the runner is
 * flaky. */

const OUTPUT_CONTRACT = [
  "",
  "----",
  "OUTPUT CONTRACT (for the tool that called you):",
  "Return ONLY the finished file: a `---` frontmatter block, then the",
  "markdown body. No preamble, no closing remarks, no code fences around",
  "the file. The first line of your output must be `---`.",
].join("\n");

export function buildWritePrompt(briefMarkdown: string): string {
  return briefMarkdown + OUTPUT_CONTRACT;
}

export interface FailedLaw {
  law?: string;
  threshold?: string | null;
  observed?: string | null;
  excerpt?: string | null;
  passed?: boolean;
}

/** The repair prompt: the previous draft plus only what failed.
 *
 * "Fix only what the violations require" matters — a model asked to rewrite
 * freely will helpfully rewrite the sections that already passed, and the
 * next check fails on something new. */
export function buildRetryPrompt(previousDraft: string, laws: FailedLaw[]): string {
  return [
    "Your draft failed the publish laws below. Fix ONLY what the violations",
    "require and keep everything that already passed unchanged.",
    "",
    "FAILED LAWS:",
    failedLawsTable(laws),
    "",
    "YOUR PREVIOUS DRAFT:",
    previousDraft,
    OUTPUT_CONTRACT,
  ].join("\n");
}

export function failedLawsTable(laws: FailedLaw[]): string {
  const failed = laws.filter((row) => row.passed === false);
  if (failed.length === 0) return "(none reported)";
  return failed
    .map((row) => {
      const parts = [`- ${row.law ?? "unnamed law"}`];
      if (row.threshold != null) parts.push(`need: ${row.threshold}`);
      if (row.observed != null) parts.push(`got: ${row.observed}`);
      if (row.excerpt != null && row.excerpt !== "") {
        parts.push(`offending text: "${row.excerpt}"`);
      }
      return parts.join(" · ");
    })
    .join("\n");
}

/**
 * Recover the file from whatever the model printed.
 *
 * Two failure shapes cover nearly everything real: the whole file wrapped in
 * a code fence, and a sentence of chatter before the frontmatter. Cut to the
 * first `---` line and strip fences; anything still wrong after that is a
 * real content problem the laws will name precisely.
 */
export function cleanDraft(raw: string): string {
  let text = raw.trim();

  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    if (text.trimEnd().endsWith("```")) {
      text = text.trimEnd();
      text = text.slice(0, text.lastIndexOf("```"));
    }
  }

  const lines = text.split("\n");
  const fmIndex = lines.findIndex((line) => line.trim() === "---");
  if (fmIndex > 0) {
    // Chatter before the frontmatter. Everything above the first `---` is
    // the model talking to us, not the article.
    text = lines.slice(fmIndex).join("\n");
  }

  return text.trim() + "\n";
}
