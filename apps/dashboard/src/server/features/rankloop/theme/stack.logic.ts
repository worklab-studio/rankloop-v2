// Stack detection and the files a scaffold PR writes (spec 0030).
//
// The rule that shapes this module: an unrecognised repo is reported as
// unrecognised. Scaffolding a Next.js blog into an Eleventy site because we
// guessed produces a pull request nobody can merge, and that is a worse
// first impression than "we could not tell what this is built with".
//
// Pure. The GitHub reads and the PR happen in the service.

export type StackId = "next-app" | "next-pages" | "astro" | "static" | "unknown";

export interface StackDetection {
  stack: StackId;
  confidence: "high" | "medium" | "low";
  /** The paths that decided it, so a wrong answer can be argued with. */
  evidence: string[];
}

/** What the detector needs to look at. `true` means the path exists. */
export type RepoProbe = Record<string, boolean>;

/**
 * Paths worth probing. Kept small on purpose — each one is an API call
 * against the user's repository, and a detector that reads forty files to
 * decide between four answers is rate limit spent on certainty nobody asked
 * for.
 */
export const PROBE_PATHS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.mjs",
  "astro.config.ts",
  "app/layout.tsx",
  "app/layout.jsx",
  "src/app/layout.tsx",
  "pages/_app.tsx",
  "pages/index.tsx",
  "src/pages/index.astro",
  "index.html",
  "package.json",
] as const;

const has = (probe: RepoProbe, ...paths: string[]) => paths.some((p) => probe[p] ?? false);

export function detectStack(probe: RepoProbe): StackDetection {
  const nextConfig = ["next.config.js", "next.config.mjs", "next.config.ts"].filter(
    (p) => probe[p],
  );
  const astroConfig = ["astro.config.mjs", "astro.config.ts"].filter((p) => probe[p]);

  if (astroConfig.length > 0) {
    return { stack: "astro", confidence: "high", evidence: astroConfig };
  }

  if (nextConfig.length > 0) {
    // App router and pages router put a blog in completely different places,
    // and a repo mid-migration has both. The app directory wins because that
    // is where new routes go in a project that has one.
    const appDir = ["app/layout.tsx", "app/layout.jsx", "src/app/layout.tsx"].filter(
      (p) => probe[p],
    );
    if (appDir.length > 0) {
      return {
        stack: "next-app",
        confidence: "high",
        evidence: [...nextConfig, ...appDir],
      };
    }
    const pagesDir = ["pages/_app.tsx", "pages/index.tsx"].filter((p) => probe[p]);
    if (pagesDir.length > 0) {
      return {
        stack: "next-pages",
        confidence: "high",
        evidence: [...nextConfig, ...pagesDir],
      };
    }
    // Next.js with neither directory visible at the paths we probe. We know
    // the framework and not the router, and guessing the router is exactly
    // the guess that produces an unmergeable PR.
    return { stack: "unknown", confidence: "low", evidence: nextConfig };
  }

  if (has(probe, "index.html")) {
    return { stack: "static", confidence: "medium", evidence: ["index.html"] };
  }

  return { stack: "unknown", confidence: "low", evidence: [] };
}

export function stackLabel(stack: StackId): string {
  switch (stack) {
    case "next-app":
      return "Next.js (app router)";
    case "next-pages":
      return "Next.js (pages router)";
    case "astro":
      return "Astro";
    case "static":
      return "Static HTML";
    case "unknown":
      return "Not recognised";
  }
}

// ---------------------------------------------------------------------------
// The scaffold
// ---------------------------------------------------------------------------

export interface ScaffoldFile {
  path: string;
  content: string;
  /** Why this file exists, for the PR body. Review should be reading a
   *  description, not reverse-engineering a diff. */
  purpose: string;
}

/**
 * Where each stack's blog lives, and what the post route is called.
 *
 * `null` for a stack we do not recognise: there is no sensible default path
 * for a framework we cannot name.
 */
export function scaffoldPaths(
  stack: StackId,
  blogPath: string,
): { index: string; post: string; styles: string } | null {
  const root = blogPath.replace(/^\/+|\/+$/g, "") || "blog";
  switch (stack) {
    case "next-app":
      return {
        index: `app/${root}/page.tsx`,
        post: `app/${root}/[slug]/page.tsx`,
        styles: `app/${root}/rankloop-theme.css`,
      };
    case "next-pages":
      return {
        index: `pages/${root}/index.tsx`,
        post: `pages/${root}/[slug].tsx`,
        styles: `styles/rankloop-theme.css`,
      };
    case "astro":
      return {
        index: `src/pages/${root}/index.astro`,
        post: `src/pages/${root}/[slug].astro`,
        styles: `src/styles/rankloop-theme.css`,
      };
    case "static":
      return {
        index: `${root}/index.html`,
        post: `${root}/_template.html`,
        styles: `${root}/rankloop-theme.css`,
      };
    case "unknown":
      return null;
  }
}

/**
 * Which of the planned files may actually be written.
 *
 * "rankloop only edits a block it created" applies to whole files here: the
 * scaffold ADDS. A path that already exists is skipped and reported, never
 * overwritten — a user's existing blog layout is not ours to replace, and a
 * PR that silently clobbers it is the worst thing this feature could do.
 */
export function planWrites(
  files: readonly ScaffoldFile[],
  existing: ReadonlySet<string>,
): { write: ScaffoldFile[]; skipped: ScaffoldFile[] } {
  const write: ScaffoldFile[] = [];
  const skipped: ScaffoldFile[] = [];
  for (const file of files) {
    if (existing.has(file.path)) skipped.push(file);
    else write.push(file);
  }
  return { write, skipped };
}

/** The PR body: every file added, every file skipped, every token used. */
export function pullRequestBody(input: {
  stack: StackId;
  written: readonly ScaffoldFile[];
  skipped: readonly ScaffoldFile[];
  themeSummary: readonly { name: string; value: string; confidence: string }[];
  needsReview: readonly string[];
}): string {
  const lines = [
    "This PR adds a blog to your site, styled from your own pages.",
    "",
    `**Stack detected:** ${stackLabel(input.stack)}`,
    "",
    "### Files added",
    ...input.written.map((f) => `- \`${f.path}\` — ${f.purpose}`),
  ];

  if (input.skipped.length > 0) {
    lines.push(
      "",
      "### Files skipped",
      "These already exist and rankloop did not touch them:",
      ...input.skipped.map((f) => `- \`${f.path}\``),
    );
  }

  lines.push(
    "",
    "### Theme",
    "Taken from your live site:",
    "",
    "| Token | Value | Confidence |",
    "| --- | --- | --- |",
    ...input.themeSummary.map((t) => `| ${t.name} | \`${t.value}\` | ${t.confidence} |`),
  );

  if (input.needsReview.length > 0) {
    lines.push(
      "",
      // Said plainly in the PR rather than buried in the dashboard: the
      // reviewer is the person who can actually tell whether the font is
      // right, and this is the moment they are looking.
      `⚠️ Worth a look before merging — rankloop is not confident about: ${input.needsReview.join(", ")}.`,
    );
  }

  lines.push(
    "",
    "---",
    "rankloop opened this as a pull request rather than committing to your",
    "default branch. Nothing is live until you merge.",
  );
  return lines.join("\n");
}
