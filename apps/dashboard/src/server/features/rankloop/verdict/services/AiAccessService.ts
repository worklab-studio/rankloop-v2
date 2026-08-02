import {
  probeAiAccess,
  type AiAccessProbe,
} from "@/server/features/rankloop/verdict/aiAccess";
import { aiAccessFindings, type Finding } from "@/server/features/rankloop/verdict/findings.logic";
import { VerdictRepository } from "@/server/features/rankloop/verdict/repositories/VerdictRepository";
import { AppError } from "@/server/lib/errors";
import { storedProbeSchema } from "@/types/schemas/rankloopVerdict";

// The AI access card (spec 0027).
//
// No workflow behind this one, unlike site-study and gsc-sync. The probe is
// six HTTP requests and finishes in under a second against a real site, so a
// Durable Object, a run row and the stale-run machinery would all be
// ceremony around something that fits in a request. If it ever grows a
// per-page crawl, that changes.

export interface AiAccessAgentRow {
  name: string;
  operator: string;
  purpose: "training" | "search" | "user-fetch";
  allowed: boolean;
  /** The robots.txt line that decided, when one did. Carries the directive
   *  as well as the pattern: rendered as a bare path, an `Allow: /` reads
   *  like a restriction, which is the opposite of what it says. */
  rule: { type: "allow" | "disallow"; pattern: string; line: number } | null;
}

export interface AiAccessCard {
  /** `never-run` is a first-run state, not an empty one: the difference is
   *  whether the user is looking at a result or at a button. `unreadable`
   *  means a snapshot exists but was written in a shape this release cannot
   *  parse — the user still just presses the button, but saying "nothing has
   *  run" would be false. */
  state: "never-run" | "ready" | "unreadable";
  checkedAt: string | null;
  canonicalOrigin: string | null;
  /** True when the domain the user entered is not the one that serves. Worth
   *  surfacing: it is usually fine, and occasionally it is the whole bug. */
  redirected: boolean;
  reachable: boolean;
  agents: AiAccessAgentRow[];
  llmsTxtPresent: boolean;
  llmsFullPresent: boolean;
  htmlWords: number | null;
  findings: Finding[];
}

const EMPTY_CARD: AiAccessCard = {
  state: "never-run",
  checkedAt: null,
  canonicalOrigin: null,
  redirected: false,
  reachable: false,
  agents: [],
  llmsTxtPresent: false,
  llmsFullPresent: false,
  htmlWords: null,
  findings: [],
};

function toAgentRows(probe: AiAccessProbe): AiAccessAgentRow[] {
  return probe.agents.map((v) => ({
    name: v.agent.name,
    operator: v.agent.operator,
    purpose: v.agent.purpose,
    allowed: !v.blocked,
    rule: v.root.rule ?? v.blog.rule ?? null,
  }));
}

async function buildCard(
  projectId: string,
  probe: AiAccessProbe,
  checkedAt: string,
): Promise<AiAccessCard> {
  const site = await VerdictRepository.getProjectSite(projectId);
  const corpus = await VerdictRepository.getCorpusForLlmsTxt(projectId);
  return {
    state: "ready",
    checkedAt,
    canonicalOrigin: probe.canonicalOrigin,
    redirected: probe.redirected,
    reachable: probe.reachable,
    agents: toAgentRows(probe),
    llmsTxtPresent:
      probe.llmsFiles.find((f) => f.path === "/llms.txt")?.present ?? false,
    llmsFullPresent:
      probe.llmsFiles.find((f) => f.path === "/llms-full.txt")?.present ?? false,
    htmlWords: probe.jsGating?.words ?? null,
    findings: aiAccessFindings({
      probe,
      siteName: site?.name ?? probe.canonicalOrigin,
      blogPath: site?.blogPath ?? "blog",
      corpus,
    }),
  };
}

/** Run the probe now and store the result. */
async function runProbe(projectId: string): Promise<AiAccessCard> {
  const site = await VerdictRepository.getProjectSite(projectId);
  if (!site) throw new AppError("NOT_FOUND", "Project not found");

  const probe = await probeAiAccess({
    siteUrl: normalizeSiteUrl(site.domain),
    blogPath: site.blogPath,
  });
  const row = await VerdictRepository.insertSnapshot({ projectId, probe });
  return buildCard(projectId, probe, row.createdAt);
}

/** The stored result, or the first-run state when nothing has run. */
async function getCard(projectId: string): Promise<AiAccessCard> {
  const row = await VerdictRepository.latestSnapshot(projectId);
  if (!row) return EMPTY_CARD;

  const parsed = storedProbeSchema.safeParse(row.payload);
  if (!parsed.success) return { ...EMPTY_CARD, state: "unreadable" };

  // Findings are derived, never stored: the rules change with the product and
  // a stored finding would be frozen at the wording of the release that wrote
  // it. The probe is the fact; everything else is a view of it.
  return buildCard(projectId, parsed.data, row.createdAt);
}

/** Projects store a bare domain; the probe needs an absolute URL. */
export function normalizeSiteUrl(domain: string): string {
  const trimmed = domain.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

export const AiAccessService = {
  runProbe,
  getCard,
};
