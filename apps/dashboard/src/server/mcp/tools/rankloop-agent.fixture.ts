import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
import type { ToolExtra } from "@/server/mcp/context";
import type { LawReport } from "@/server/features/rankloop/writing/gate";

// Shared seed data for the rankloop agent-path tool tests. Split out because
// the tools are exercised from two files (the read tools, and the writing loop)
// and a second copy of the drafts would let one file's fixture drift into
// grading something the other file never checks.

export const PROJECT_ID = "project_1";
export const PROPOSAL_ID = "proposal_1";

const authContext = {
  userId: "user_1",
  userEmail: "alice@example.com",
  organizationId: "org_1",
  clientId: "client_1",
  scopes: ["mcp"],
  audience: "https://rankloop.test/mcp",
  subject: "user_1",
  baseUrl: "https://rankloop.test",
};

/** An OAuth-authenticated caller, as the MCP SDK hands it to a tool handler. */
export const toolExtra: ToolExtra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: {
    token: "token",
    clientId: "client_1",
    scopes: ["mcp"],
    resource: new URL("https://rankloop.test/mcp"),
    extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
  } satisfies AuthInfo,
};

/** The text content block, which is all an MCP client that ignores
 *  structuredContent would ever show a user. */
export function toolText(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

/**
 * Re-run the validation the MCP SDK performs after a handler returns.
 *
 * The SDK turns an output-schema mismatch into a -32602 JSON-RPC error it
 * never rethrows, so a tool whose schema rejects its own payload fails for
 * every caller while its handler test still passes. This is the only place
 * that gap gets closed.
 */
export async function parsesAgainstOutputSchema(
  outputSchema: AnySchema | ZodRawShapeCompat | undefined,
  result: CallToolResult,
): Promise<boolean> {
  const schema = normalizeObjectSchema(outputSchema);
  if (!schema) throw new Error("the tool declares no output schema");
  return (await safeParseAsync(schema, result.structuredContent)).success;
}

/** The law report a tool put in structuredContent, at its real type. */
export function reportOf(result: CallToolResult): LawReport {
  const report = result.structuredContent?.report;
  if (report === null || typeof report !== "object") {
    throw new Error("the response carried no law report");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool writes this key from a LawReport in the same call
  return report as LawReport;
}

// A draft that meets the contract below, and one that breaks three laws that
// can each point at text: an em dash, a banned phrase, and a link to a page
// the site does not have.
export const COMPLIANT_DRAFT = `---
title: Dialing in espresso on a home machine
description: What I changed to get repeatable shots without buying anything.
date: 2026-08-01
category: Guides
keyword: espresso grind size
---

I would check every shot on my own machine for a week before trusting any of
this. The numbers below are the ones I wrote down at the machine, not the ones
a manufacturer prints on the side of a box. Nothing here needed new gear.

## Start coarse and tighten one notch at a time

Espresso grind size is the only variable worth moving on the first day. Set the
dose, keep it there, and change nothing else until the shot runs somewhere near
thirty seconds. Small moves beat big ones, because a burr set travels further
than the numbers on the collar suggest, and two notches at once hides which one
of them did the work.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grinder problems long before they are
machine problems, which is why I stopped replacing hardware to fix taste. A
week of notes was cheaper than any of the upgrades I had been considering.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for this style. Older beans run faster and want a finer setting. The
[burr grinder guide](/blog/burr-grinder-guide/) covers the machine side, and it
is the piece I would read first if the timings never settle down.
`;

export const BROKEN_DRAFT = COMPLIANT_DRAFT.replace(
  "The numbers below are the ones I wrote down",
  "In the ever-evolving world of home coffee — the numbers below are the ones I wrote down",
).replace("/blog/burr-grinder-guide/", "/blog/no-such-page/");

/** Bands narrow enough that a fixture-sized draft can satisfy them; the laws
 *  the contract is allowed to move are exactly these five. */
export const CONTRACT = {
  requiredBlocks: ["faq"],
  wordBand: [60, 400],
  h2Min: 2,
  faqMin: 1,
  internalLinksMin: 1,
  schemaType: "Article",
  notes: [],
};

export const PAGE_TYPE = {
  id: "type_1",
  name: "Guides",
  status: "approved",
  urlPattern: "/blog/{slug}/",
  templateContractJson: JSON.stringify(CONTRACT),
};

export const APPROVED_PROPOSAL = {
  id: PROPOSAL_ID,
  projectId: PROJECT_ID,
  type: "write_new",
  track: "net_new",
  status: "approved",
  target: "espresso grind size",
  title: "Espresso grind size",
  pageTypeId: "type_1",
  keywordBacklogId: "kw_1",
};

export const LINKABLE_PAGES = [
  {
    path: "/blog/burr-grinder-guide/",
    title: "Burr grinders",
    category: "Guides",
  },
];
