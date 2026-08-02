// Turning an AI access finding into an artifact (spec 0027, the fix contract).
//
// The naive fix — append `User-agent: GPTBot` / `Allow: /` — is wrong in a way
// that is easy to ship and hard to notice. Adding a NAMED group makes it the
// only group that governs that agent: the site's `User-agent: *` rules stop
// applying to it entirely. So a site that carefully disallows `/admin/` and
// `/checkout/` for everyone would, the moment we "fixed" its AI access, be
// handing those exact paths to GPTBot. We would have opened a door the user
// never agreed to open, in a patch labelled as a fix.
//
// So the plan here splits in two:
//   - additive, when only the wildcard group blocks the agent — we write a
//     named group that grants what is needed and CARRIES OVER every other
//     wildcard restriction;
//   - manual, when a named group already blocks the agent — no appended
//     block can win against it, so we name the line and show the edit rather
//     than pretending to fix it.

import {
  aiAccessVerdicts,
  matchesPath,
  normalizePath,
  parseRobots,
  type AccessDecision,
  type AgentVerdict,
  type AiAgent,
  type RobotsRule,
} from "@/server/features/rankloop/verdict/robots.logic";

/** Fences the region rankloop owns. "rankloop only edits a block it created"
 *  is a product law; re-applying the fix replaces this block and never the
 *  user's own lines. */
export const BLOCK_START = "# >>> rankloop managed block >>>";
export const BLOCK_END = "# <<< rankloop managed block <<<";

export interface ManualEdit {
  agent: string;
  /** 1-indexed line in the user's current robots.txt. */
  line: number;
  current: string;
  replacement: string;
  why: string;
}

export interface RobotsFixPlan {
  /** Agents the appended block will unblock. */
  additiveAgents: string[];
  /** Wildcard restrictions copied into each generated group, so the user can
   *  see for themselves that we did not widen access beyond the ask. */
  preserved: string[];
  /** Edits we will not make on the user's behalf. */
  manual: ManualEdit[];
  /** The whole file as it would be written. Null when nothing changes. */
  nextContent: string | null;
  /** For display. Null when nothing changes. */
  diff: string | null;
}

/** Which decision is responsible for an agent being unreachable. */
function blockingDecision(v: AgentVerdict): AccessDecision | null {
  if (v.root.verdict === "blocked") return v.root;
  if (v.blog.verdict === "blocked") return v.blog;
  return null;
}

function ruleLine(rule: RobotsRule): string {
  return `${rule.type === "allow" ? "Allow" : "Disallow"}: ${rule.pattern}`;
}

/**
 * Build the fix.
 *
 * `sitemapUrl` is folded in when robots.txt does not declare one — same block,
 * because it is the same file and a user should approve one patch, not two.
 */
export function planRobotsFix(input: {
  robotsText: string | null;
  blogPath: string;
  sitemapUrl?: string | null;
  agents?: readonly AiAgent[];
}): RobotsFixPlan {
  const existing = input.robotsText ?? "";
  const parsed = parseRobots(existing);
  const blog = normalizePath(input.blogPath);
  const verdicts = aiAccessVerdicts(input.robotsText, blog, input.agents);

  const additiveAgents: string[] = [];
  const manual: ManualEdit[] = [];

  for (const v of verdicts) {
    const decision = blockingDecision(v);
    if (decision === null || decision.rule === null) continue;

    if (decision.matchedAgent === "*" || decision.matchedAgent === null) {
      additiveAgents.push(v.agent.name);
      continue;
    }
    // A named group already governs this agent, and a named group beats
    // anything we append. Saying "fixed" here would be a lie the user
    // discovers weeks later in their logs.
    manual.push({
      agent: v.agent.name,
      line: decision.rule.line,
      current: ruleLine(decision.rule),
      replacement: "Allow: /",
      why: `\`User-agent: ${decision.matchedAgent}\` is a group of its own, so it overrides anything added elsewhere in the file. This line has to change in place.`,
    });
  }

  // Every wildcard restriction that is NOT what blocks us. These ride along
  // into each generated group; dropping them is how a fix quietly opens
  // /admin/ to a crawler.
  const wildcardRules = parsed.groups
    .filter((g) => g.agents.includes("*"))
    .flatMap((g) => g.rules);
  const preservedRules = wildcardRules.filter(
    (r) =>
      r.type === "disallow" &&
      !matchesPath(r, "/") &&
      !matchesPath(r, blog),
  );
  const preserved = [...new Set(preservedRules.map(ruleLine))];

  const needsSitemap =
    Boolean(input.sitemapUrl) && parsed.sitemaps.length === 0;

  if (additiveAgents.length === 0 && !needsSitemap) {
    return { additiveAgents, preserved: [], manual, nextContent: null, diff: null };
  }

  const block = renderBlock({
    agents: additiveAgents,
    preserved,
    sitemapUrl: needsSitemap ? (input.sitemapUrl ?? null) : null,
  });
  const nextContent = upsertManagedBlock(existing, block);

  return {
    additiveAgents,
    preserved: additiveAgents.length > 0 ? preserved : [],
    manual,
    nextContent,
    diff: unifiedDiff(existing, nextContent, "robots.txt"),
  };
}

export function renderBlock(input: {
  agents: string[];
  preserved: string[];
  sitemapUrl: string | null;
}): string {
  const lines: string[] = [BLOCK_START];
  if (input.agents.length > 0) {
    lines.push(
      "# Grants these crawlers the same access a browser has. Any Disallow",
      "# below is copied from your `User-agent: *` group and still applies.",
    );
  }
  for (const agent of input.agents) {
    lines.push("", `User-agent: ${agent}`, "Allow: /", ...input.preserved);
  }
  if (input.sitemapUrl !== null) {
    lines.push("", `Sitemap: ${input.sitemapUrl}`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Write the managed block into a robots.txt, replacing any previous one.
 *
 * Idempotent by construction: running the fix twice produces the same file,
 * which is what makes it safe to offer as a button rather than a one-shot.
 */
export function upsertManagedBlock(existing: string, block: string): string {
  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + BLOCK_END.length);
    return `${before}${block}${after}`;
  }
  if (existing.trim() === "") return `${block}\n`;
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}

/**
 * A unified diff for the one region that changed.
 *
 * Not a general differ — every edit this module makes is a single contiguous
 * region (append, or replace the managed block), so common-prefix/suffix is
 * exact here and a full LCS would only add ways to be wrong.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  filename: string,
): string | null {
  if (oldText === newText) return null;
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const aEnd = a.length - suf;
  const bEnd = b.length - suf;
  const CONTEXT = 3;
  const ctxStart = Math.max(0, pre - CONTEXT);
  const ctxEndA = Math.min(a.length, aEnd + CONTEXT);
  const ctxEndB = Math.min(b.length, bEnd + CONTEXT);

  const out = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -${ctxStart + 1},${ctxEndA - ctxStart} +${ctxStart + 1},${ctxEndB - ctxStart} @@`,
  ];
  for (let i = ctxStart; i < pre; i++) out.push(` ${a[i]}`);
  for (let i = pre; i < aEnd; i++) out.push(`-${a[i]}`);
  for (let i = pre; i < bEnd; i++) out.push(`+${b[i]}`);
  // The trailing context is the common suffix, so a and b agree here.
  for (let i = aEnd; i < ctxEndA; i++) out.push(` ${a[i]}`);
  return out.join("\n");
}
