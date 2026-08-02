// Turning a probe into findings (spec 0027, the finding → fix contract).
//
// The type below is the contract: `fix` is required. A finding that cannot
// say what to do about itself is not allowed to exist, because a list of
// problems with no artifacts is an audit tool, and the whole claim of Act I
// is that rankloop closes them.
//
// Pure. The severity rules and the wording are the product here, so they are
// unit-tested rather than discovered in a screenshot.

import type { AiAccessProbe } from "@/server/features/rankloop/verdict/aiAccess";
import { MIN_HTML_WORDS } from "@/server/features/rankloop/verdict/aiAccess";
import {
  planRobotsFix,
  unifiedDiff,
  type ManualEdit,
} from "@/server/features/rankloop/verdict/robotsFix.logic";

export type Severity = "critical" | "warning";

/** Only true of robots.txt, which is the one file rankloop fences a block
 *  inside. Stated on the finding rather than in the UI, so a patch for a
 *  file with no managed block never inherits the claim. */
const REAPPLY_NOTE =
  "Re-applying it replaces rankloop's block rather than adding a second one.";

/** Every fix is an artifact. `patch` is a file we can write, `manual` is a
 *  change only the user can make (a dashboard toggle, a server config), and
 *  `list` is the set of URLs a finding is about. */
export type Fix =
  | {
      kind: "patch";
      filename: string;
      diff: string;
      content: string;
      /** Edits an appended block cannot make; each names a line. */
      manualEdits?: ManualEdit[];
      note?: string;
    }
  | { kind: "manual"; steps: string[] }
  | { kind: "list"; note: string; items: string[] };

export interface Finding {
  /** Stable across runs, so the UI can keep a card open while a probe reruns. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: Fix;
}

export interface FindingsInput {
  probe: AiAccessProbe;
  siteName: string;
  /** The path rankloop publishes to. Checked separately from the site root,
   *  because a site can allow `/` and disallow the blog. */
  blogPath: string;
  /** From the site study, for generating llms.txt. Empty is fine. */
  corpus: { url: string; title: string | null; description: string | null }[];
}

export function aiAccessFindings(input: FindingsInput): Finding[] {
  const { probe } = input;
  const findings: Finding[] = [];

  // -------------------------------------------------------------------------
  // Reachability comes first: nothing below means anything if we never got in
  // -------------------------------------------------------------------------
  if (!probe.reachable) {
    return [
      {
        id: "unreachable",
        severity: "critical",
        title: "we could not load your site",
        detail: `${probe.enteredUrl} did not answer. Every other check on this card is blank because none of them could run.`,
        fix: {
          kind: "manual",
          steps: [
            "Confirm the domain is spelled correctly in project settings.",
            "Open the site in a browser — if it loads for you but not for us, the block is at your CDN or firewall.",
          ],
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // robots.txt that cannot be read
  // -------------------------------------------------------------------------
  if (probe.robots.state === "unavailable") {
    // The most urgent thing this card can find, and the least known. A 404
    // means "everything is allowed"; a 5xx means the opposite, and crawlers
    // that cannot read the file are required to stop crawling the site.
    findings.push({
      id: "robots-unavailable",
      severity: "critical",
      title: "robots.txt is failing, not missing",
      detail: `${probe.robots.url} returned ${probe.robots.status ?? "a network error"}. A crawler that cannot read robots.txt has to assume it is disallowed everywhere, so this one file can quietly stop your whole site being crawled. A 404 here would be harmless; a 5xx is not.`,
      fix: {
        kind: "manual",
        steps: [
          "Serve robots.txt with a 200, or remove it entirely so it returns 404.",
          "A 404 is safe: with no robots.txt, everything is permitted.",
        ],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Blocked agents
  // -------------------------------------------------------------------------
  const blocked = probe.agents.filter((a) => a.blocked);
  const retrieval = blocked.filter((a) => a.agent.purpose !== "training");
  const training = blocked.filter((a) => a.agent.purpose === "training");

  const sitemapUrl = probe.parsedRobots.sitemaps[0] ?? null;
  const plan = planRobotsFix({
    robotsText: probe.robots.state === "ok" ? probe.robots.text : null,
    blogPath: input.blogPath,
    sitemapUrl,
  });

  function robotsPatch(note: string): Fix {
    if (plan.nextContent === null || plan.diff === null) {
      return {
        kind: "manual",
        steps: plan.manual.map(
          (m) => `robots.txt line ${m.line}: change \`${m.current}\` to \`${m.replacement}\``,
        ),
      };
    }
    return {
      kind: "patch",
      filename: "robots.txt",
      diff: plan.diff,
      content: plan.nextContent,
      manualEdits: plan.manual.length > 0 ? plan.manual : undefined,
      note,
    };
  }

  if (retrieval.length > 0) {
    findings.push({
      id: "ai-retrieval-blocked",
      severity: "critical",
      title: `${retrieval.length} AI ${retrieval.length === 1 ? "crawler that answers questions is" : "crawlers that answer questions are"} blocked`,
      detail: `${listAgents(retrieval.map((a) => a.agent.name))} fetch pages to answer questions and cite sources. Blocked, your pages cannot be quoted in those answers. ${describeRules(retrieval)}`,
      fix: robotsPatch(
        plan.preserved.length > 0
          ? `Your existing restrictions (${plan.preserved.join(", ")}) are copied into each new group, so this grants access to the same paths a browser already has and nothing more. ${REAPPLY_NOTE}`
          : `This grants the same access a browser already has. ${REAPPLY_NOTE}`,
      ),
    });
  }

  if (training.length > 0) {
    // Deliberately a warning and deliberately phrased as a choice. Plenty of
    // people block training on purpose, and a tool that scolds them for it
    // teaches them to ignore the whole card.
    findings.push({
      id: "ai-training-blocked",
      severity: "warning",
      title: `${training.length} AI training ${training.length === 1 ? "crawler is" : "crawlers are"} blocked`,
      detail: `${listAgents(training.map((a) => a.agent.name))} collect pages for model training. Many sites block these on purpose — if that was the intent, nothing here needs doing. ${describeRules(training)}`,
      fix: robotsPatch(
        `Only apply this if you want these crawlers to have access. ${REAPPLY_NOTE}`,
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Edge-level blocking
  // -------------------------------------------------------------------------
  const edgeBlocked = probe.edge.filter((e) => e.blocked);
  if (edgeBlocked.length > 0) {
    findings.push({
      id: "edge-blocked",
      severity: "critical",
      title: "something in front of your site is blocking AI crawlers",
      detail: `${edgeBlocked.map((e) => `${e.agent}: ${e.reason}`).join("; ")}. This is not in robots.txt — it is a rule at your CDN or firewall, which is why an audit that only reads robots.txt reports this site as open.`,
      fix: {
        kind: "manual",
        steps: [
          "Cloudflare: Security → Bots → turn off “Block AI Scrapers and Crawlers”.",
          "Any WAF: look for a rule matching on user agent, and exempt the crawlers you want.",
          "Then re-run this check.",
        ],
      },
    });
  }

  // -------------------------------------------------------------------------
  // llms.txt
  // -------------------------------------------------------------------------
  const missingLlms = probe.llmsFiles.filter((f) => !f.present);
  if (missingLlms.length > 0) {
    const content = renderLlmsTxt({
      siteName: input.siteName,
      origin: probe.canonicalOrigin,
      pages: input.corpus,
    });
    findings.push({
      id: "llms-txt-missing",
      severity: "warning",
      title: `${missingLlms.map((f) => f.path).join(" and ")} ${missingLlms.length === 1 ? "is" : "are"} missing`,
      detail:
        input.corpus.length > 0
          ? `An llms.txt lists your pages in one place for AI agents. Generated below from the ${input.corpus.length} ${input.corpus.length === 1 ? "page" : "pages"} we crawled.`
          : "An llms.txt lists your pages in one place for AI agents. We have not crawled your site yet, so the file below is the minimum valid version — re-run this after a site study for the full listing.",
      fix: {
        kind: "patch",
        filename: "llms.txt",
        // A new file diffs against nothing, which is a real unified diff and
        // not a special case — the UI renders one shape for every patch.
        diff: unifiedDiff("", content, "llms.txt") ?? "",
        content,
        note: "Serve this at /llms.txt.",
      },
    });
  }

  // -------------------------------------------------------------------------
  // Content that is not in the HTML
  // -------------------------------------------------------------------------
  if (probe.jsGating !== null && !probe.jsGating.contentInHtml) {
    findings.push({
      id: "content-not-in-html",
      severity: "critical",
      title: "we found almost no text in your HTML",
      // Phrased strictly as what was measured. We do not run JavaScript, so
      // no wording here may imply we know what a rendering crawler sees.
      detail: `${probe.jsGating.url} returned ${probe.jsGating.words} words of text in the HTML itself, below the ${MIN_HTML_WORDS} we treat as a real page. We do not run JavaScript, so this is a measurement of the HTML, not a verdict on your site. Crawlers that also do not run JavaScript would see what we saw.`,
      fix: {
        kind: "list",
        note: "Check whether this page is server-rendered. If the text only appears after JavaScript runs, server-side rendering or prerendering is what changes it.",
        items: [probe.jsGating.url],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Sitemap discoverability
  // -------------------------------------------------------------------------
  if (probe.robots.state === "ok" && probe.parsedRobots.sitemaps.length === 0) {
    findings.push({
      id: "sitemap-not-declared",
      severity: "warning",
      title: "robots.txt does not point to your sitemap",
      detail:
        "A Sitemap line in robots.txt is how a crawler finds your sitemap without guessing. It costs one line.",
      fix: {
        kind: "manual",
        steps: [
          `Add \`Sitemap: ${probe.canonicalOrigin}/sitemap.xml\` to robots.txt.`,
        ],
      },
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listAgents(names: string[]): string {
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Quote the rule that decided, so the user can check us against their own
 *  file rather than taking our word for it. */
function describeRules(
  blocked: { agent: { name: string }; root: { rule: { pattern: string; line: number } | null } }[],
): string {
  const cited = blocked
    .map((b) => (b.root.rule ? `line ${b.root.rule.line} (\`Disallow: ${b.root.rule.pattern}\`)` : null))
    .filter((v): v is string => v !== null);
  const unique = [...new Set(cited)];
  if (unique.length === 0) return "";
  return `Blocked by ${unique.join(", ")} in your robots.txt.`;
}

/**
 * Render an llms.txt from crawled pages.
 *
 * Not the engine's `llmsTxt`: that one takes parsed `Post` objects with raw
 * bodies and word counts, and what we have here is a crawl — URLs, titles,
 * descriptions. Forcing crawl rows into Post shape to reuse the function
 * would mean inventing fields, so this renders the same format from the data
 * that actually exists.
 */
export function renderLlmsTxt(input: {
  siteName: string;
  origin: string;
  pages: { url: string; title: string | null; description: string | null }[];
}): string {
  const lines = [`# ${input.siteName}`, ""];
  lines.push(`> Pages on ${input.origin}, listed for AI agents.`, "");

  if (input.pages.length === 0) {
    lines.push("## Pages", "", `- [${input.siteName}](${input.origin})`, "");
    return lines.join("\n");
  }

  lines.push("## Pages", "");
  for (const page of input.pages) {
    const title = page.title?.trim() || page.url;
    const suffix = page.description?.trim() ? `: ${page.description.trim()}` : "";
    lines.push(`- [${title}](${page.url})${suffix}`);
  }
  lines.push("");
  return lines.join("\n");
}
