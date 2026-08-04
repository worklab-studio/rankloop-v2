/** What we can learn about a repo without asking.
 *
 * `rankloop-local init` runs inside the user's website repo, and every
 * question it does not have to ask is a question that cannot be answered
 * wrong. Everything here returns a guess plus where the guess came from, so
 * init can show its reasoning and the user can correct one field instead of
 * filling in six.
 *
 * Pure: the caller passes file contents in. */

export type Stack = "next-app" | "next-pages" | "astro" | "static" | "unknown";

export interface RepoFacts {
  /** Which files exist, relative to the repo root. */
  present: Set<string>;
  /** Contents of the files we read, keyed the same way. Missing is fine. */
  contents: Record<string, string>;
  /** `git remote get-url origin`, when there is one. */
  remote: string | null;
}

/** Files init reads. Short on purpose — a scan of the whole tree would be
 *  slower and would still guess wrong about a monorepo. */
export const DETECT_FILES = [
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.mjs",
  "astro.config.ts",
  "app/layout.tsx",
  "src/app/layout.tsx",
  "pages/index.tsx",
  "index.html",
  "wrangler.toml",
  "wrangler.jsonc",
  "wrangler.json",
  "public/CNAME",
  "CNAME",
] as const;

export function detectStack(facts: RepoFacts): Stack {
  const has = (p: string) => facts.present.has(p);
  if (has("astro.config.mjs") || has("astro.config.ts")) return "astro";
  if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts")) {
    if (has("app/layout.tsx") || has("src/app/layout.tsx")) return "next-app";
    if (has("pages/index.tsx")) return "next-pages";
    return "unknown";
  }
  if (has("index.html")) return "static";
  return "unknown";
}

/**
 * Where post markdown should live.
 *
 * `content/blog` for every stack, because that is what the GitHub adapter
 * already writes to and what the scaffold PR already reads from. A third
 * convention here would mean the runner and the publisher disagree about
 * where posts are, and the blog would render empty with nothing obviously
 * wrong.
 */
export const DEFAULT_CONTENT_DIR = "content/blog";

/**
 * The public URL, guessed from whatever the repo already states.
 *
 * Ordered by how deliberate each source is: a CNAME file is a domain
 * somebody typed, a wrangler route is a domain somebody configured, a
 * package.json homepage is often stale, and a GitHub remote is a guess of
 * last resort.
 */
export function detectDomain(facts: RepoFacts): { domain: string; from: string } | null {
  const cname = (facts.contents["public/CNAME"] ?? facts.contents.CNAME ?? "").trim();
  if (cname !== "") {
    return { domain: normalizeDomain(cname), from: "your CNAME file" };
  }

  for (const file of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
    const raw = facts.contents[file];
    if (!raw) continue;
    // Both the TOML and JSONC shapes state a route pattern the same way.
    const route = /["']?pattern["']?\s*[:=]\s*["']([^"']+)["']/.exec(raw);
    if (route?.[1]) {
      return { domain: normalizeDomain(route[1]), from: `a route in ${file}` };
    }
  }

  const pkg = facts.contents["package.json"];
  if (pkg) {
    const homepage = /"homepage"\s*:\s*"([^"]+)"/.exec(pkg);
    if (homepage?.[1] && /^https?:\/\//i.test(homepage[1])) {
      return { domain: normalizeDomain(homepage[1]), from: "package.json homepage" };
    }
  }

  return null;
}

/** Strip protocol, path, wildcards and trailing dots down to a bare host. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^\*\./, "")
    .split("/")[0]!
    .replace(/\.+$/, "")
    .toLowerCase();
}

/** `https://<domain>/blog` — the URL the runner polls before reporting. */
export function suggestUrlBase(domain: string, blogPath = "blog"): string {
  return `https://${normalizeDomain(domain)}/${blogPath.replace(/^\/+|\/+$/g, "")}`;
}

export interface RepoSummary {
  stack: Stack;
  stackLabel: string;
  contentDir: string;
  domain: { domain: string; from: string } | null;
  remote: string | null;
}

export function summarize(facts: RepoFacts): RepoSummary {
  const stack = detectStack(facts);
  return {
    stack,
    stackLabel: stackLabel(stack),
    contentDir: DEFAULT_CONTENT_DIR,
    domain: detectDomain(facts),
    remote: facts.remote,
  };
}

export function stackLabel(stack: Stack): string {
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
      return "not recognised";
  }
}
