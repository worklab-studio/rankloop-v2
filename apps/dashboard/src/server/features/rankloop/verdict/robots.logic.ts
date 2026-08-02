// robots.txt, parsed properly (spec 0027, the AI access card).
//
// This file exists because the AI access card makes a claim about the user's
// own file back to them — "ClaudeBot is blocked, by line 14" — and a claim
// like that has to be right. A naive `text.includes("GPTBot")` gets the
// common case and then lies on every file with grouped user-agent lines, an
// Allow carve-out, or a `$` anchor. Users check this against their own
// robots.txt; being wrong here costs more trust than the card earns.
//
// Semantics follow RFC 9309 plus the two Google extensions (`*` wildcards and
// `$` anchoring) that every robots.txt in the wild is written against. No
// I/O — the fetching lives in aiAccess.ts so this stays unit-testable.

// ---------------------------------------------------------------------------
// The agents we report on
// ---------------------------------------------------------------------------

/**
 * The crawlers worth a row on the card, grouped by who operates them.
 *
 * Protocol-level names, not niche vocabulary — hard rule 2 is about the
 * user's subject matter (products, domains, category regexes) living in
 * config, and these are the same for every site on earth.
 *
 * `purpose` is what the operator uses the crawl FOR, and it is the whole
 * reason the list is split this way: blocking a training crawler is a
 * deliberate, defensible choice, while blocking a retrieval crawler means
 * your pages cannot be cited in answers. Presenting both as one "AI: blocked"
 * verdict would flatten a real decision into a scold.
 */
export const AI_AGENTS: readonly AiAgent[] = [
  { name: "GPTBot", operator: "OpenAI", purpose: "training" },
  { name: "OAI-SearchBot", operator: "OpenAI", purpose: "search" },
  { name: "ChatGPT-User", operator: "OpenAI", purpose: "user-fetch" },
  { name: "ClaudeBot", operator: "Anthropic", purpose: "training" },
  { name: "Claude-SearchBot", operator: "Anthropic", purpose: "search" },
  { name: "Claude-User", operator: "Anthropic", purpose: "user-fetch" },
  { name: "PerplexityBot", operator: "Perplexity", purpose: "search" },
  { name: "Perplexity-User", operator: "Perplexity", purpose: "user-fetch" },
  { name: "Google-Extended", operator: "Google", purpose: "training" },
  { name: "CCBot", operator: "Common Crawl", purpose: "training" },
  { name: "Bytespider", operator: "ByteDance", purpose: "training" },
  { name: "Amazonbot", operator: "Amazon", purpose: "search" },
  { name: "Applebot-Extended", operator: "Apple", purpose: "training" },
  { name: "meta-externalagent", operator: "Meta", purpose: "training" },
] as const;

export interface AiAgent {
  name: string;
  operator: string;
  /**
   * training  — corpus collection for model training
   * search    — index build for AI answers; blocking costs you citations
   * user-fetch— fetches one URL because a user asked; blocking breaks links
   *             a human explicitly pasted
   */
  purpose: "training" | "search" | "user-fetch";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface RobotsRule {
  type: "allow" | "disallow";
  /** The pattern exactly as written, so the UI can quote the user's own file. */
  pattern: string;
  /** 1-indexed, so "line 14" in the UI means line 14 in their editor. */
  line: number;
}

export interface RobotsGroup {
  /** Lowercased user-agent values. Several lines before the first rule
   *  form ONE group that all of them share — a detail worth getting right,
   *  because `User-agent: GPTBot` + `User-agent: CCBot` + `Disallow: /` is
   *  the single most common way a site blocks AI. */
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  /** `Sitemap:` is a global directive — it belongs to the file, not a group. */
  sitemaps: string[];
  /** Lines we could not classify, kept so the UI can say so rather than
   *  silently dropping a directive the user believes is in force. */
  unknownDirectives: { field: string; line: number }[];
}

const RULE_FIELDS = new Set(["allow", "disallow"]);

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const unknownDirectives: { field: string; line: number }[] = [];

  let current: RobotsGroup | null = null;
  // A `user-agent` line directly after a RULE starts a new group; one after
  // another user-agent line joins the group being built. This flag is the
  // whole of that rule.
  let lastWasRule = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    // Comments run to end of line and may follow a value.
    const withoutComment = raw.split("#")[0] ?? "";
    const trimmed = withoutComment.trim();
    if (trimmed === "") continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue; // not a directive; ignore rather than guess
    const field = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    const line = i + 1;

    if (field === "user-agent") {
      if (current === null || lastWasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasRule = false;
      continue;
    }

    if (RULE_FIELDS.has(field)) {
      // A rule before any user-agent line belongs to no group. Google's
      // parser drops these; so do we, rather than inventing an owner.
      if (current === null) continue;
      // `Disallow:` with an empty value means "nothing is disallowed" — it is
      // not a rule, and treating it as one would block the whole site.
      if (!(field === "disallow" && value === "")) {
        current.rules.push({
          type: field === "allow" ? "allow" : "disallow",
          pattern: value,
          line,
        });
      }
      lastWasRule = true;
      continue;
    }

    if (field === "sitemap") {
      if (value !== "") sitemaps.push(value);
      continue;
    }

    // crawl-delay, host, clean-param, and anything else: recorded, not acted
    // on. Recording them lets the UI stay honest about what we did not read.
    unknownDirectives.push({ field, line });
  }

  return { groups, sitemaps, unknownDirectives };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Turn a robots path pattern into a regex.
 *
 * `*` matches any run of characters and `$` anchors to end-of-path — the two
 * Google extensions. `$` is only special as the FINAL character: a `$` in the
 * middle of a path is a literal dollar sign in a query string, and treating
 * it as an anchor would silently un-block a URL.
 *
 * Everything else is a literal prefix match, which is why `/blog` also covers
 * `/blogging` — surprising, but it is what the standard says, and a parser
 * that "helpfully" required a boundary would disagree with the crawler.
 */
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

export function matchesPath(rule: RobotsRule, path: string): boolean {
  // An empty Allow pattern matches nothing meaningful; empty Disallow was
  // already dropped at parse time.
  if (rule.pattern === "") return false;
  return patternToRegex(rule.pattern).test(path);
}

/**
 * Pick the group that governs `agent`.
 *
 * RFC 9309 selects by product token with `*` as the fallback, and the
 * universal implementation detail is that the MOST SPECIFIC token wins:
 * `User-agent: Googlebot-News` governs Googlebot-News even when a
 * `User-agent: Googlebot` group also exists. We compare by prefix and keep
 * the longest match, which reproduces that.
 *
 * The `*` group is used only when no named group matched — a named group
 * REPLACES the wildcard group rather than adding to it. This is the detail
 * that decides most real files: a site with `User-agent: *` / `Disallow: /`
 * and a later `User-agent: GPTBot` / `Allow: /` is open to GPTBot, and a
 * parser that merged the two would report it blocked.
 */
export function selectGroup(
  parsed: ParsedRobots,
  agent: string,
): { group: RobotsGroup; matchedAgent: string } | null {
  const wanted = agent.toLowerCase();
  let best: { group: RobotsGroup; matchedAgent: string } | null = null;

  for (const group of parsed.groups) {
    for (const candidate of group.agents) {
      if (candidate === "*") continue;
      if (!wanted.startsWith(candidate)) continue;
      if (best === null || candidate.length > best.matchedAgent.length) {
        best = { group, matchedAgent: candidate };
      }
    }
  }
  if (best !== null) return best;

  // Several `User-agent: *` groups are malformed but happen; merging their
  // rules is more faithful to intent than picking the first and dropping the
  // rest.
  const wildcardRules = parsed.groups
    .filter((g) => g.agents.includes("*"))
    .flatMap((g) => g.rules);
  if (wildcardRules.length === 0) {
    const hasWildcardGroup = parsed.groups.some((g) => g.agents.includes("*"));
    if (!hasWildcardGroup) return null;
  }
  return { group: { agents: ["*"], rules: wildcardRules }, matchedAgent: "*" };
}

export interface AccessDecision {
  verdict: "allowed" | "blocked";
  /** Which user-agent line governed, or null when no group applied. */
  matchedAgent: string | null;
  /** The rule that decided it. Null means nothing matched — allowed by
   *  default, which the UI must phrase differently from an explicit Allow. */
  rule: RobotsRule | null;
}

/**
 * Decide whether `agent` may fetch `path`.
 *
 * Precedence is RFC 9309: the longest matching pattern wins, and an Allow
 * beats a Disallow of equal length. That tie-break is the entire reason
 * `Disallow: /` + `Allow: /blog/` works, and it is what lets a fix be a
 * two-line addition instead of a rewrite of the user's file.
 */
export function decideAccess(
  parsed: ParsedRobots,
  agent: string,
  path: string,
): AccessDecision {
  const selected = selectGroup(parsed, agent);
  if (selected === null) {
    return { verdict: "allowed", matchedAgent: null, rule: null };
  }

  let winner: RobotsRule | null = null;
  for (const rule of selected.group.rules) {
    if (!matchesPath(rule, path)) continue;
    if (winner === null) {
      winner = rule;
      continue;
    }
    if (rule.pattern.length > winner.pattern.length) {
      winner = rule;
      continue;
    }
    // Equal length: Allow wins. Checked explicitly so the winning rule the UI
    // quotes is the Allow, not whichever happened to be written first.
    if (rule.pattern.length === winner.pattern.length && rule.type === "allow") {
      winner = rule;
    }
  }

  return {
    verdict: winner?.type === "disallow" ? "blocked" : "allowed",
    matchedAgent: selected.matchedAgent,
    rule: winner,
  };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface AgentVerdict {
  agent: AiAgent;
  /** Access to the site root. */
  root: AccessDecision;
  /** Access to the blog path, which fails independently: a site can allow
   *  `/` and disallow `/blog/`, leaving it invisible exactly where rankloop
   *  publishes. Reporting only the root would call that site healthy. */
  blog: AccessDecision;
  /** True when the agent can reach neither. */
  blocked: boolean;
}

/**
 * Per-agent verdicts for the AI access card.
 *
 * `robotsText` of null means we could not read a robots.txt at all. Absent
 * robots.txt means everything is permitted — that is the standard's default,
 * not an error, and the card says "no robots.txt (everything allowed)".
 */
export function aiAccessVerdicts(
  robotsText: string | null,
  blogPath: string,
  agents: readonly AiAgent[] = AI_AGENTS,
): AgentVerdict[] {
  const parsed = parseRobots(robotsText ?? "");
  const blog = normalizePath(blogPath);
  return agents.map((agent) => {
    const rootDecision = decideAccess(parsed, agent.name, "/");
    const blogDecision = decideAccess(parsed, agent.name, blog);
    return {
      agent,
      root: rootDecision,
      blog: blogDecision,
      blocked:
        rootDecision.verdict === "blocked" && blogDecision.verdict === "blocked",
    };
  });
}

/** `blog` / `/blog` / `blog/` all mean `/blog/` to a matcher. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

/** Whether the sitemap is discoverable from robots.txt — a Structure-card
 *  finding whose fix is a one-line diff. */
export function sitemapDeclared(parsed: ParsedRobots): boolean {
  return parsed.sitemaps.length > 0;
}
