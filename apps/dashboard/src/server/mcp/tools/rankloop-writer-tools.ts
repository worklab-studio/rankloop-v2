import { z } from "zod";
import { AgentReportService } from "@/server/features/rankloop/agent/services/AgentReportService";
import { AgentService } from "@/server/features/rankloop/agent/services/AgentService";
import { BriefService } from "@/server/features/rankloop/writing/services/BriefService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";
import type { LawVerdict } from "@/server/features/rankloop/writing/gate";

// The writing loop over MCP (spec 0023): fetch the brief, submit the draft for
// grading, report what shipped.
//
// `rankloop_check` is the one that matters. It is deliberately a tool rather
// than advice, because an agent that can call the grader can iterate against
// it — and the grader still has no model anywhere on its dependency graph. It
// reaches `ArticleGateService.gradeDraft`, which is the same function the
// dashboard's own gate calls, so the report an agent iterates against is the
// report publishing will re-run. There is no second grader to keep in sync,
// and there must never be one.

/** The article body's ceiling. A guard, not a law: the word-count law is what
 *  bounds an article, and this only stops a paste that could never be one.
 *  Mirrors `recheckRankloopArticleSchema`, which guards the same bytes on the
 *  dashboard's own re-check. */
const MAX_DRAFT_CHARS = 200_000;

const draftSchema = z
  .string()
  .min(1)
  .max(MAX_DRAFT_CHARS)
  .describe(
    "The draft as `--- key: value ---` frontmatter plus a markdown body — the shape the brief asks for. Graded exactly as submitted.",
  );

/** The law verdicts, permissive on each row. Named fields would have to be
 *  edited every time the engine grows a law, and an output schema that
 *  rejected a new law would take the whole tool down with it. */
const lawReportOutputSchema = z
  .object({
    slug: z.string(),
    passed: z.boolean(),
    violations: z.number(),
    checkedAt: z.string(),
    frontmatterParsed: z.boolean(),
    failure: z.object({}).passthrough().nullable(),
    laws: z.array(z.object({}).passthrough()),
  })
  .passthrough();

const LAW_COLUMNS: McpTableColumn<LawVerdict>[] = [
  { header: "law", value: (row) => row.law },
  { header: "verdict", value: (row) => (row.passed ? "pass" : "FAIL") },
  { header: "threshold", value: (row) => row.threshold },
  { header: "observed", value: (row) => row.observed },
  { header: "excerpt", value: (row) => row.excerpt },
];

// ---------------------------------------------------------------------------
// rankloop_brief
// ---------------------------------------------------------------------------

const briefInputSchema = {
  projectId: projectIdSchema,
  proposalId: z
    .string()
    .min(1)
    .describe("Proposal ID from rankloop_proposals."),
  allowSerpFetch: z
    .boolean()
    .optional()
    .describe(
      "Allow one live SERP call when no cached snapshot exists for this keyword. Defaults to false, which renders the brief on cached grounding only and reports what a fetch would have cost. This is the only thing a brief can spend money on, and it spends it at most once per keyword.",
    ),
} as const;

type BriefArgs = z.infer<z.ZodObject<typeof briefInputSchema>>;

export const rankloopBriefTool = {
  name: "rankloop_brief",
  config: {
    title: "Rankloop brief",
    description:
      "The grounded writing brief for an approved proposal — the same document the dashboard renders: the keyword's evidence, the page type's contract, the site's linkable pages, the voice card, and the publish laws the draft will be graded against. Write the page natively in your repo's stack from this, then grade it with rankloop_check. Costs nothing unless `allowSerpFetch` is true AND no SERP snapshot is cached for the keyword.",
    inputSchema: briefInputSchema,
    outputSchema: {
      markdown: z.string(),
      keyword: z.string(),
      serpSource: z.string(),
      serpFetchedAt: z.string().nullable(),
      costUsd: z.number(),
      wouldCostUsd: z.number(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      // A cached brief writes nothing, but `allowSerpFetch` buys a SERP and
      // stores the snapshot, so this is not honestly read-only.
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BriefArgs, context) => {
    const allowSerpFetch = args.allowSerpFetch ?? false;
    // Priced before it is bought, in the same call the agent is deciding in —
    // the house rule for anything metered. When the fetch is allowed this is
    // still worth reading, because it is what says the spend was avoidable.
    const preview = await BriefService.getBriefCost({
      projectId: args.projectId,
      proposalId: args.proposalId,
    });
    const brief = await BriefService.buildBrief({
      projectId: args.projectId,
      proposalId: args.proposalId,
      billingCustomer: context.billing,
      allowSerpFetch,
    });

    const priceLine =
      brief.costUsd > 0
        ? `This brief bought one SERP: $${brief.costUsd.toFixed(3)}.`
        : preview.willFetchSerp
          ? `No SERP cached for "${brief.keyword}". Re-run with allowSerpFetch=true to buy one for $${preview.costUsd.toFixed(3)}.`
          : "This brief spent nothing.";

    return mcpResponse({
      text: [
        `Brief for "${brief.keyword}" (search context: ${brief.serpSource}).`,
        priceLine,
        "",
        brief.markdown,
      ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/opportunities`,
      ),
      structuredContent: {
        markdown: brief.markdown,
        keyword: brief.keyword,
        serpSource: brief.serpSource,
        serpFetchedAt: brief.serpFetchedAt,
        costUsd: brief.costUsd,
        // What a fetch would cost if one is still available to buy; 0 once
        // there is nothing left to pay for.
        wouldCostUsd: preview.willFetchSerp ? preview.costUsd : 0,
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// rankloop_check
// ---------------------------------------------------------------------------

const checkInputSchema = {
  projectId: projectIdSchema,
  proposalId: z
    .string()
    .min(1)
    .describe(
      "Proposal ID from rankloop_proposals. Its page type decides which laws apply and at what thresholds, so the draft is graded against the contract its own brief promised.",
    ),
  draft: draftSchema,
} as const;

type CheckArgs = z.infer<z.ZodObject<typeof checkInputSchema>>;

export const rankloopCheckTool = {
  name: "rankloop_check",
  config: {
    title: "Rankloop check",
    description:
      "Grade a draft against the publish laws and get the full report back as data: every law, pass or fail, with its threshold, what the draft actually has, and the offending text where a law can point at one. This is the engine — no model call, no credits, no write — so call it as many times as it takes to pass. Publishing re-runs exactly this check, so a passing report here is a page that will land.",
    inputSchema: checkInputSchema,
    outputSchema: {
      proposalId: z.string(),
      keyword: z.string(),
      slug: z.string(),
      passed: z.boolean(),
      violations: z.number(),
      report: lawReportOutputSchema,
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CheckArgs, context) => {
    const result = await AgentService.checkDraft({
      projectId: args.projectId,
      proposalId: args.proposalId,
      draft: args.draft,
      checkedAt: new Date().toISOString(),
    });
    const { report } = result;
    const headline = report.passed
      ? `PASS — all ${report.laws.length} laws met for "${result.keyword}" (slug ${result.slug}).`
      : `FAIL — ${report.violations} of ${report.laws.length} laws unmet for "${result.keyword}".`;
    return mcpResponse({
      text: [
        headline,
        ...(report.frontmatterParsed
          ? []
          : [
              "No frontmatter was found. Every metadata law fails for that one reason — fix the `--- key: value ---` block first.",
            ]),
        formatMcpTable(report.laws, LAW_COLUMNS),
      ].join("\n"),
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: {
        proposalId: result.proposalId,
        keyword: result.keyword,
        slug: result.slug,
        passed: report.passed,
        violations: report.violations,
        report,
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// rankloop_publish_report
// ---------------------------------------------------------------------------

const publishReportInputSchema = {
  projectId: projectIdSchema,
  proposalId: z
    .string()
    .min(1)
    .describe("Proposal ID the shipped page was written for."),
  url: z
    .string()
    .url()
    .describe(
      "The page's live URL. Required: it is what the receipt measures and what the next brief links to.",
    ),
  path: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Site-relative path, e.g. /compare/foo/. Derived from the URL when omitted.",
    ),
  commit: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The commit SHA that shipped the page, if the target is a repo."),
  pullRequestUrl: z
    .string()
    .url()
    .optional()
    .describe("The pull request the page landed in."),
  draft: draftSchema
    .optional()
    .describe(
      "The markdown that shipped, if the page has a markdown source. Graded and stored with the article so the receipt carries a quality record. Omit for a page written in components — the CI `rankloop check` is where that tree meets the laws.",
    ),
} as const;

type PublishReportArgs = z.infer<z.ZodObject<typeof publishReportInputSchema>>;

export const rankloopPublishReportTool = {
  name: "rankloop_publish_report",
  config: {
    title: "Rankloop publish report",
    description:
      "Report a page your agent shipped. The article moves to published, the page enters rankloop's manifest so the next brief can link to it and the next site study will not prune it, the proposal closes, and a receipt opens with a real pre-publish baseline. Call this once per page, after it is live — calling it twice is a no-op, not a second receipt. Writes nothing to your site: your agent already did that.",
    inputSchema: publishReportInputSchema,
    outputSchema: {
      articleId: z.string(),
      proposalId: z.string(),
      url: z.string(),
      path: z.string(),
      publishedAt: z.string(),
      alreadyReported: z.boolean(),
      report: lawReportOutputSchema.nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PublishReportArgs, context) => {
    const result = await AgentReportService.reportPublished({
      projectId: args.projectId,
      proposalId: args.proposalId,
      url: args.url,
      path: args.path,
      commit: args.commit,
      pullRequestUrl: args.pullRequestUrl,
      draft: args.draft,
      reportedAt: new Date().toISOString(),
    });

    const lawLine = result.report
      ? result.report.passed
        ? `The submitted draft meets all ${result.report.laws.length} laws.`
        : `The submitted draft has ${result.report.violations} unmet law(s); the report is stored on the article.`
      : "No draft was submitted, so no law report is stored for this page.";

    return mcpResponse({
      text: result.alreadyReported
        ? `Already reported: ${result.url} is published and has a receipt. Nothing changed.`
        : [
            `Published ${result.url} (${result.path}).`,
            "Manifest updated and a receipt opened — it measures in 28 days.",
            lawLine,
          ].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/receipts`,
      ),
      structuredContent: { ...result },
    });
  }),
};
