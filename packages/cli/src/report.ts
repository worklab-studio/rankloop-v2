/** Rendering violations, in the two formats CI cares about.
 *
 * Human format is `path:line: law` — the shape every compiler and linter has
 * used since cc, so an editor's error parser and `grep` both already
 * understand it without being taught. GitHub format is the workflow-command
 * annotation, which puts the same verdict on the pull request's own diff. */

export interface Violation {
  /** Repo-relative, POSIX-separated. */
  file: string;
  slug: string;
  law: string;
  line: number;
}

/** GitHub workflow commands are newline-delimited, so a message carrying a
 * newline would truncate the annotation and swallow the rest of the log.
 * The percent escape has to go first or it would double-escape the others.
 * (Same escaping the official @actions/core does.) */
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function githubAnnotation(violation: Violation): string {
  const file = escapeProperty(violation.file);
  const title = escapeProperty(`rankloop: ${violation.law}`);
  const message = escapeData(`${violation.slug} breaks the law: ${violation.law}`);
  return `::error file=${file},line=${violation.line},title=${title}::${message}`;
}

export function humanLine(violation: Violation): string {
  return `${violation.file}:${violation.line}: ${violation.law}`;
}

export function formatViolation(violation: Violation, format: "human" | "github"): string {
  return format === "github" ? githubAnnotation(violation) : humanLine(violation);
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/** The line a human reads first when the log is 400 lines long: how much is
 * broken, and how much is fine. A count of failures alone says nothing about
 * whether the corpus is one bad post or forty. */
export function summarize(violations: Violation[], postCount: number): string {
  if (violations.length === 0) {
    return `validated ${plural(postCount, "post")}: all laws pass`;
  }
  const broken = new Set(violations.map((violation) => violation.slug)).size;
  return (
    `${plural(violations.length, "violation")} in ${plural(broken, "post")}; ` +
    `${postCount - broken} of ${postCount} pass`
  );
}
