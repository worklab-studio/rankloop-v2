// Display rules for the AI access card. Pure, so the wording that decides
// whether a user trusts this screen is asserted in tests rather than
// discovered in a screenshot.

import type { AiAccessAgentRow, AiAccessCard } from "@/server/features/rankloop/verdict/services/AiAccessService";

/** What the operator uses the crawl for, in the user's language. */
export function purposeLabel(purpose: AiAccessAgentRow["purpose"]): string {
  switch (purpose) {
    case "search":
      return "answers questions";
    case "user-fetch":
      return "fetches when asked";
    case "training":
      return "model training";
  }
}

/**
 * Why the distinction is worth a column.
 *
 * A blocked training crawler and a blocked search crawler look identical in
 * robots.txt and mean completely different things: one is an opt-out plenty
 * of people choose on purpose, the other quietly removes you from answers.
 */
export function purposeHelp(purpose: AiAccessAgentRow["purpose"]): string {
  switch (purpose) {
    case "search":
      return "Fetches pages to answer questions and cite sources. Blocked, you cannot be quoted.";
    case "user-fetch":
      return "Fetches a page because someone pasted the link. Blocked, that link fails for a human.";
    case "training":
      return "Collects pages for model training. Blocking this is a common, deliberate choice.";
  }
}

export interface AgentGroup {
  operator: string;
  agents: AiAccessAgentRow[];
  blocked: number;
}

/** Grouped by who runs the crawler, because that is how the decision is made:
 *  people allow or block an operator, not a user-agent string. */
export function groupByOperator(agents: readonly AiAccessAgentRow[]): AgentGroup[] {
  const byOperator = new Map<string, AiAccessAgentRow[]>();
  for (const agent of agents) {
    const list = byOperator.get(agent.operator) ?? [];
    list.push(agent);
    byOperator.set(agent.operator, list);
  }
  return [...byOperator.entries()].map(([operator, list]) => ({
    operator,
    agents: list,
    blocked: list.filter((a) => !a.allowed).length,
  }));
}

export interface Headline {
  tone: "good" | "warning" | "critical";
  title: string;
  detail: string;
}

/**
 * The one line at the top.
 *
 * A clean site gets a sentence that means it, not a neutral summary of
 * counts. If passing looks the same as failing, the card is decoration.
 */
export function headlineFor(card: AiAccessCard): Headline {
  if (card.state === "never-run") {
    return {
      tone: "warning",
      title: "Not checked yet",
      detail:
        "This reads your robots.txt, looks for llms.txt, and checks whether anything in front of your site turns AI crawlers away.",
    };
  }
  if (card.state === "unreadable") {
    return {
      tone: "warning",
      title: "The last result cannot be read",
      detail:
        "It was saved by an older version of rankloop. Run the check again to replace it.",
    };
  }
  if (!card.reachable) {
    return {
      tone: "critical",
      title: "We could not load your site",
      detail: "Nothing below could run. Check the domain in project settings.",
    };
  }

  const critical = card.findings.filter((f) => f.severity === "critical").length;
  const warnings = card.findings.filter((f) => f.severity === "warning").length;
  const blocked = card.agents.filter((a) => !a.allowed).length;

  if (critical > 0) {
    return {
      tone: "critical",
      title: `${critical} ${critical === 1 ? "thing needs" : "things need"} attention`,
      detail:
        blocked > 0
          ? `${blocked} of ${card.agents.length} AI crawlers cannot read your site.`
          : "Your robots.txt is fine; the problem is elsewhere.",
    };
  }
  if (warnings > 0) {
    return {
      tone: "warning",
      title: `${warnings} ${warnings === 1 ? "suggestion" : "suggestions"}`,
      detail: `All ${card.agents.length} AI crawlers we check can read your site.`,
    };
  }
  return {
    tone: "good",
    title: `All ${card.agents.length} AI crawlers can read your site`,
    detail: "robots.txt is open, llms.txt is served, and nothing is blocking bots at the edge.",
  };
}

export function severityChipClass(severity: "critical" | "warning"): string {
  return severity === "critical"
    ? "bg-error/15 text-error"
    : "bg-warning/15 text-warning";
}

export function severityLabel(severity: "critical" | "warning"): string {
  return severity === "critical" ? "Needs attention" : "Suggested";
}

export function toneTextClass(tone: Headline["tone"]): string {
  if (tone === "good") return "text-success";
  if (tone === "critical") return "text-error";
  return "text-warning";
}

/**
 * The redirect note.
 *
 * Shown only when the entered domain is not the one that serves, because
 * that is the case where every file we read lives somewhere the user did not
 * type — and occasionally it is the whole bug.
 */
export function redirectNote(card: AiAccessCard): string | null {
  if (!card.redirected || card.canonicalOrigin === null) return null;
  return `Your domain redirects to ${card.canonicalOrigin}, so that is where we read robots.txt and llms.txt.`;
}
