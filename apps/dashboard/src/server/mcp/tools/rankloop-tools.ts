import { z } from "zod";
import { AgentService } from "@/server/features/rankloop/agent/services/AgentService";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";

// The read side of the agent path (spec 0023): what the loop owes, what is
// approved and unwritten, and what the writing moved. All three read the same
// services the dashboard reads, so an agent and a browser open on one project
// can never disagree about it. None of them spends anything.

// ---------------------------------------------------------------------------
// rankloop_status
// ---------------------------------------------------------------------------

/** Status counts arrive as a `{ status: count }` rollup rather than a fixed
 *  field per status: the article and proposal enums grow, and a schema naming
 *  each one would reject a project the day one is added. */
const statusCountsOutputSchema = z.record(z.string(), z.number());

const statusInputSchema = {
  projectId: projectIdSchema,
} as const;

type StatusArgs = z.infer<z.ZodObject<typeof statusInputSchema>>;

function describeQuota(status: {
  quota: { owed: number | null; outstanding: number; slots: number };
}): string {
  const { owed, outstanding, slots } = status.quota;
  return owed === null
    ? `Quota: off. ${outstanding} net-new proposal(s) in flight.`
    : `Quota: ${owed} owed today, ${outstanding} in flight, ${slots} slot(s) open.`;
}

export const rankloopStatusTool = {
  name: "rankloop_status",
  config: {
    title: "Rankloop status",
    description:
      "The writing loop's state for a project: today's quota (with any indexation throttle and the reason for it), article and proposal counts by status, the project's writer mode, and what this app's own writer has spent to date. Uses no credits and calls no model. Start here — `slots` and `writerMode` tell you whether there is work for an agent to pick up.",
    inputSchema: statusInputSchema,
    outputSchema: {
      projectId: z.string(),
      writerMode: z.string(),
      quota: z
        .object({
          owed: z.number().nullable(),
          outstanding: z.number(),
          slots: z.number(),
          reason: z.string().nullable(),
          throttle: looseObjectOutputSchema.nullable(),
        })
        .passthrough(),
      exclusions: z.array(looseObjectOutputSchema),
      articles: statusCountsOutputSchema,
      proposals: statusCountsOutputSchema,
      spendToDateUsd: z.number(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: StatusArgs, context) => {
    const status = await AgentService.getStatus(args.projectId);
    const lines = [
      `Writer mode: ${status.writerMode}`,
      describeQuota(status),
      ...(status.quota.reason ? [`Blocked: ${status.quota.reason}`] : []),
      ...(status.quota.throttle
        ? [
            `Indexation throttle: cap ${status.quota.throttle.cap} — ${status.quota.throttle.reason}`,
          ]
        : []),
      ...status.exclusions.map(
        (exclusion) =>
          `Held back: ${exclusion.pageTypeName} (${exclusion.keywordCount} keyword(s)) — ${exclusion.reason}`,
      ),
      `Articles: ${describeCounts(status.articles)}`,
      `Proposals: ${describeCounts(status.proposals)}`,
      `Spend to date: $${status.spendToDateUsd.toFixed(2)}`,
    ];
    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/articles`,
      ),
      structuredContent: { ...status },
    });
  }),
};

/** "review 3, approved 1", or "none" — a bare empty object reads as a bug. */
function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return entries.length === 0
    ? "none"
    : entries.map(([status, count]) => `${status} ${count}`).join(", ");
}

// ---------------------------------------------------------------------------
// rankloop_proposals
// ---------------------------------------------------------------------------

const PROPOSAL_COLUMNS: McpTableColumn<{
  proposalId: string;
  keyword: string;
  pageTypeName: string | null;
  score: number;
  article: { status: string } | null;
  evidence: string[];
}>[] = [
  { header: "proposal", value: (row) => row.proposalId },
  { header: "keyword", value: (row) => row.keyword },
  { header: "page type", value: (row) => row.pageTypeName },
  { header: "score", value: (row) => row.score },
  { header: "article", value: (row) => row.article?.status ?? null },
  { header: "evidence", value: (row) => row.evidence.join("; ") },
];

const proposalsInputSchema = {
  projectId: projectIdSchema,
} as const;

type ProposalsArgs = z.infer<z.ZodObject<typeof proposalsInputSchema>>;

export const rankloopProposalsTool = {
  name: "rankloop_proposals",
  config: {
    title: "Rankloop proposals",
    description:
      "Approved net-new proposals awaiting writing, with the evidence behind each one and the page type it belongs to. A row whose `article` is non-null already has a draft in flight — write the ones where it is null. Pass a `proposalId` from here to rankloop_brief. Uses no credits and calls no model.",
    inputSchema: proposalsInputSchema,
    outputSchema: {
      proposals: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ProposalsArgs, context) => {
    const proposals = await AgentService.listProposals(args.projectId);
    const text =
      proposals.length === 0
        ? "No approved proposals are waiting to be written. Approve some in the Opportunities screen, or check rankloop_status for why the quota proposed nothing."
        : `Approved proposals (${proposals.length}):\n${formatMcpTable(
            proposals,
            PROPOSAL_COLUMNS,
          )}`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/opportunities`,
      ),
      structuredContent: { proposals },
    });
  }),
};

// ---------------------------------------------------------------------------
// rankloop_receipts
// ---------------------------------------------------------------------------

/** Newest-first, and this many by default. A receipt is one row per published
 *  action, so a year of daily publishing is ~365 rows — worth capping in a
 *  response an agent reads token by token, not worth paginating. */
const DEFAULT_RECEIPT_LIMIT = 50;
const MAX_RECEIPT_LIMIT = 200;

const RECEIPT_COLUMNS: McpTableColumn<{
  target: string;
  status: string;
  actionType: string;
  createdAt: string;
  result: {
    clicksDelta: number | null;
    adjustedClicksDelta: number | null;
  } | null;
}>[] = [
  { header: "target", value: (row) => row.target },
  { header: "action", value: (row) => row.actionType },
  { header: "status", value: (row) => row.status },
  { header: "opened", value: (row) => row.createdAt.slice(0, 10) },
  { header: "clicks Δ", value: (row) => row.result?.clicksDelta ?? null },
  {
    header: "adjusted Δ",
    value: (row) => row.result?.adjustedClicksDelta ?? null,
  },
];

const receiptsInputSchema = {
  projectId: projectIdSchema,
  measuredOnly: z
    .boolean()
    .optional()
    .describe(
      "Return only receipts whose measurement window has closed (status measured or contaminated). Defaults to false, which includes receipts still waiting on their 28-day window.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECEIPT_LIMIT)
    .optional()
    .describe(
      `Newest-first cap on returned receipts. Defaults to ${DEFAULT_RECEIPT_LIMIT}.`,
    ),
} as const;

type ReceiptsArgs = z.infer<z.ZodObject<typeof receiptsInputSchema>>;

/** Closed windows only. 'contaminated' counts as measured: the window really
 *  did close, and the honest thing is to hand over the numbers with the flag
 *  that says another action overlapped them. */
const CLOSED_RECEIPT_STATUSES = new Set(["measured", "contaminated"]);

export const rankloopReceiptsTool = {
  name: "rankloop_receipts",
  config: {
    title: "Rankloop receipts",
    description:
      "Measured receipts for a project: what each published page did over its 28-day evaluation window, against the pinned pre-publish baseline and adjusted for site-wide trend. `contaminated` means another action touched the same page inside the window, so the numbers are reported but not attributable. Uses no credits and calls no model.",
    inputSchema: receiptsInputSchema,
    outputSchema: {
      receipts: z.array(looseObjectOutputSchema),
      totalCount: z.number(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ReceiptsArgs, context) => {
    const all = await ReceiptsService.getReceipts(args.projectId);
    const filtered = args.measuredOnly
      ? all.filter((receipt) => CLOSED_RECEIPT_STATUSES.has(receipt.status))
      : all;
    const receipts = filtered.slice(0, args.limit ?? DEFAULT_RECEIPT_LIMIT);
    const text =
      receipts.length === 0
        ? "No receipts yet. One opens for every page rankloop publishes, and closes 28 days later."
        : `Receipts (${receipts.length} of ${filtered.length}):\n${formatMcpTable(
            receipts,
            RECEIPT_COLUMNS,
          )}`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/receipts`,
      ),
      structuredContent: { receipts, totalCount: filtered.length },
    });
  }),
};
