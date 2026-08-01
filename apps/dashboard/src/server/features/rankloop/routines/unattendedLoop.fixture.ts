import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { symmetricEncrypt } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/libsql";
import {
  articles,
  autopilotState,
  contentPages,
  digests,
  indexationChecks,
  keywordBacklog,
  llmSpend,
  member,
  organization,
  pageTypes,
  projects,
  proposals,
  publishConnections,
  receipts,
  user,
  writerSettings,
} from "@/db/schema";

// The world spec 0025's acceptance runs in: a real SQLite database built from
// the shipped D1 migrations, one project seeded exactly the way the spec words
// it ("trustDial='autopilot', an eligible action type, healthy indexation, an
// approved page type and planned keywords"), and doubles for the only two
// things a machine publishing on its own must not really touch — the model and
// the network.
//
// Split out of the test because the seed is the argument: every knob the five
// preconditions read is a parameter of `seed()`, so a refusal proof is the same
// world with one field changed rather than a second fixture that could differ
// in ways nobody meant.

const client = createClient({ url: ":memory:" });
export const testDb = drizzle(client);

const MIGRATIONS_DIR = new URL("../../../../../drizzle", import.meta.url)
  .pathname;

/** The shipped D1 migrations, replayed. Hand-written DDL here would be a
 *  second definition of the schema, and a proof about stored rows is only
 *  worth as much as the table those rows land in. */
async function applyMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const name of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
}

await applyMigrations();

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const ORG_ID = "org_1";
export const PROJECT_ID = "project_1";
const DOMAIN = "beanpress.example";
const SITE_URL = `https://${DOMAIN}`;
export const PAGE_TYPE_ID = "type_guides";
export const PROPOSAL_ID = "proposal_1";
export const KEYWORD_ID = "kw_1";
export const KEYWORD = "espresso grind size";
export const SLUG = "dialing-in-espresso-on-a-home-machine";
const HUB_PATH = "/blog/";
const WEBHOOK_URL = "https://hooks.example/rankloop";
export const DIGEST_WEBHOOK_URL = "https://hooks.example/digest";
/** The 32-char secret the fixture's connection blob is genuinely encrypted
 *  under, and the one the digest signature is genuinely derived from. */
export const AUTH_SECRET = "0123456789abcdef0123456789abcdef";

/** The pinned clock. Everything dated below is relative to it, so the settled
 *  cohort and the indexation window mean what they say. */
export const NOW = new Date("2026-08-01T07:00:00.000Z");
export const TODAY = NOW.toISOString().slice(0, 10);

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Sized to the fixture draft below, exactly as gate.test.ts sizes it. */
const CONTRACT = {
  requiredBlocks: ["faq"],
  wordBand: [60, 400],
  h2Min: 2,
  faqMin: 1,
  internalLinksMin: 1,
  schemaType: "Article",
  notes: [],
};

/** Ten published posts: the internal-link targets the draft points at, and the
 *  indexation cohort the throttle is computed over. Published inside the 7–45
 *  day window, and `source: 'publish'` because that is the only source the
 *  cohort query counts — a crawled page is not something this engine shipped
 *  and so is not evidence about what it ships. */
const NEIGHBOURS = [
  { id: "page_a", path: "/blog/burr-grinder-guide/", title: "Burr grinders" },
  { id: "page_b", path: "/blog/descaling/", title: "Descaling" },
  { id: "page_c", path: "/blog/water-hardness/", title: "Water hardness" },
  { id: "page_d", path: "/blog/basket-sizes/", title: "Basket sizes" },
  { id: "page_e", path: "/blog/tamping/", title: "Tamping" },
  { id: "page_f", path: "/blog/preinfusion/", title: "Preinfusion" },
  { id: "page_g", path: "/blog/milk-texture/", title: "Milk texture" },
  { id: "page_h", path: "/blog/portafilter-fit/", title: "Portafilter fit" },
  { id: "page_i", path: "/blog/scale-choice/", title: "Scales" },
  { id: "page_j", path: "/blog/bean-storage/", title: "Bean storage" },
];

const USER_PROSE = `# Notes

Prose the user wrote, and nobody else may touch.
`;

// The draft the mocked model returns. Lifted from the writer's own row proof
// so the gate it clears here is the gate that already deploys.
export const COMPLIANT_DRAFT = `---
title: Dialing in espresso on a home machine
description: What I changed to get repeatable shots without buying anything.
date: ${TODAY}
category: Guides
keyword: espresso grind size
---

I measured every shot on my home machine for a week before I trusted any of
this. The numbers below are the ones I wrote down, not the ones a manufacturer
prints on a box.

## Start coarse and tighten one notch at a time

Espresso grind size is the only variable worth moving on the first day. Set the
dose, keep it there, and change nothing else until the shot runs somewhere near
thirty seconds. Small moves beat big ones, because a burr set travels further
than the numbers on the collar suggest.

## What the shot time is telling you

A fast shot is under extracted and tastes sour. A slow one is over extracted
and tastes bitter and dry. Both are grind problems long before they are machine
problems, which is why I stopped replacing gear to fix taste.

## How long should a double shot take?

Between twenty five and thirty two seconds from first drip, for most beans
roasted for espresso. Older beans run faster and want a finer setting.

## What I would check next

If the taste still swings between two shots in a row, weigh the dose. My own
swing came from scooping rather than weighing, and it disappeared the day I put
the basket on a scale. The [burr grinder guide](/blog/burr-grinder-guide/)
covers the machine side.
`.trim();

/** A draft the laws reject: a banned phrase, and the only internal link
 *  pointing at a path no page serves. Three of these in a row is the kill
 *  switch's trip condition. */
export const BROKEN_DRAFT = COMPLIANT_DRAFT.replace(
  "The [burr grinder guide](/blog/burr-grinder-guide/)\ncovers the machine side.",
  "Let's explore the tradeoffs. The [burr grinder guide](/blog/grinder-myths/)\ncovers the machine side.",
);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedOptions = {
  trustDial?: "titles" | "drafts" | "autopilot";
  /** The proposal's action type. 'merge' and 'prune' can never be eligible. */
  proposalType?: "write_new" | "merge" | "prune";
  /** Share of the indexation cohort Google indexed. 1 is healthy; 0.3 pauses
   *  net-new. */
  indexedShare?: number;
  /** A stored pause on `autopilot_state` — the kill switch already tripped. */
  pausedReason?: string | null;
  /** Whether the receipt cohort makes `write_new` eligible. */
  eligible?: boolean;
  digestWebhookUrl?: string | null;
  connectionStatus?: "unconfigured" | "ok" | "failed";
};

async function encryptedWebhookConfig(): Promise<string> {
  return symmetricEncrypt({
    key: AUTH_SECRET,
    data: JSON.stringify({
      defaultPostStatus: "draft",
      linkInjection: true,
      url: WEBHOOK_URL,
      secret: "a-long-random-string",
      siteUrl: SITE_URL,
    }),
  });
}

function metrics(weightedPosition: number, start: string, end: string) {
  return {
    impressions: 400,
    clicks: 20,
    ctr: 0.05,
    weightedPosition,
    siteImpressions: 4000,
    siteClicks: 200,
    window: { start, end },
  };
}

/**
 * The settled receipt cohort behind `autopilotEligibility`.
 *
 * Five `write_new` receipts whose windows closed more than 90 days ago, each an
 * improvement, plus three receipts of another type as the control group the
 * drift term needs. `eligible: false` flips the five to losses, which is the
 * honest way to make the type ineligible: the cohort exists and says no.
 */
function receiptRows(eligible: boolean) {
  const rows: (typeof receipts.$inferInsert)[] = [];
  for (let index = 0; index < 5; index += 1) {
    const end = daysBefore(120 + index);
    rows.push({
      id: `receipt_write_${index}`,
      projectId: PROJECT_ID,
      actionType: "write_new",
      status: "measured",
      windowStart: daysBefore(148 + index),
      windowEnd: end,
      baselineJson: JSON.stringify(metrics(20, daysBefore(176 + index), end)),
      resultJson: JSON.stringify({
        ...metrics(eligible ? 12 : 28, daysBefore(148 + index), end),
        clicksDelta: 4,
        siteClicksDeltaRatio: 0.01,
        adjustedClicksDelta: 3.5,
      }),
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const end = daysBefore(130 + index);
    rows.push({
      id: `receipt_control_${index}`,
      projectId: PROJECT_ID,
      actionType: "retitle",
      status: "measured",
      windowStart: daysBefore(158 + index),
      windowEnd: end,
      baselineJson: JSON.stringify(metrics(15, daysBefore(186 + index), end)),
      resultJson: JSON.stringify({
        ...metrics(15, daysBefore(158 + index), end),
        clicksDelta: 0,
        siteClicksDeltaRatio: 0,
        adjustedClicksDelta: 0,
      }),
    });
  }
  return rows;
}

export async function seed(options: SeedOptions = {}): Promise<void> {
  const {
    trustDial = "autopilot",
    proposalType = "write_new",
    indexedShare = 1,
    pausedReason = null,
    eligible = true,
    digestWebhookUrl = null,
    connectionStatus = "ok",
  } = options;

  for (const table of [
    llmSpend,
    receipts,
    digests,
    autopilotState,
    articles,
    proposals,
    writerSettings,
    publishConnections,
    indexationChecks,
    contentPages,
    keywordBacklog,
    pageTypes,
    projects,
    member,
    user,
    organization,
  ]) {
    await testDb.delete(table);
  }

  await testDb.insert(organization).values({
    id: ORG_ID,
    name: "Acme",
    slug: "acme",
    createdAt: new Date(0),
  });
  await testDb.insert(user).values({
    id: "user_1",
    name: "Operator",
    email: "operator@example.com",
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await testDb.insert(member).values({
    id: "member_1",
    organizationId: ORG_ID,
    userId: "user_1",
    role: "owner",
    createdAt: new Date(0),
  });
  await testDb.insert(projects).values({
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Beanpress",
    domain: DOMAIN,
  });
  await testDb.insert(pageTypes).values({
    id: PAGE_TYPE_ID,
    projectId: PROJECT_ID,
    name: "Guides",
    kind: "blog",
    status: "approved",
    urlPattern: "/blog/{slug}/",
    templateContractJson: JSON.stringify(CONTRACT),
  });
  await testDb.insert(keywordBacklog).values({
    id: KEYWORD_ID,
    projectId: PROJECT_ID,
    keyword: KEYWORD,
    source: "manual",
    category: "Guides",
    pageTypeId: PAGE_TYPE_ID,
    // Planned, then held by the net-new proposal below — the state the spec's
    // "planned keywords" precondition describes. On the optimize-type seeds no
    // proposal holds it, so it is parked instead: an unheld planned keyword
    // would let the net-new block queue write_new work and turn a proof about
    // one refusal into a proof about two different proposals.
    status: proposalType === "write_new" ? "proposed" : "skipped",
    searchVolume: 480,
    score: 7.2,
  });

  await testDb.insert(contentPages).values(
    NEIGHBOURS.map((neighbour, index) => ({
      id: neighbour.id,
      projectId: PROJECT_ID,
      url: `${SITE_URL}${neighbour.path}`,
      path: neighbour.path,
      kind: "post" as const,
      title: neighbour.title,
      category: "Guides",
      pageTypeId: PAGE_TYPE_ID,
      source: "publish" as const,
      // Inside the 7–45 day indexation cohort.
      publishedAt: daysBefore(20 + index),
    })),
  );
  // The cohort's verdicts. Ten checked URLs clears the minimum cohort, so this
  // is a rate the throttle is allowed to act on rather than noise — and it is
  // divisible enough that 30% is exactly 30%.
  const indexedCount = Math.round(NEIGHBOURS.length * indexedShare);
  await testDb.insert(indexationChecks).values(
    NEIGHBOURS.map((neighbour, index) => ({
      projectId: PROJECT_ID,
      url: `${SITE_URL}${neighbour.path}`,
      verdict: index < indexedCount ? "PASS" : "FAIL",
      checkedAt: `${daysBefore(1)}T04:00:00.000Z`,
    })),
  );

  await testDb.insert(proposals).values({
    id: PROPOSAL_ID,
    projectId: PROJECT_ID,
    type: proposalType,
    track: proposalType === "write_new" ? "net_new" : "optimize",
    // Undecided: whether this becomes 'approved' with decidedBy='autopilot' is
    // the whole question.
    status: "proposed",
    target: proposalType === "write_new" ? KEYWORD : "/blog/descaling/",
    pageTypeId: PAGE_TYPE_ID,
    keywordBacklogId: proposalType === "write_new" ? KEYWORD_ID : null,
    score: 7.2,
  });
  await testDb.insert(writerSettings).values({
    id: "settings_1",
    projectId: PROJECT_ID,
    trustDial,
    voiceCardMd: "Blunt, technical, first person.",
    postsPerDay: 2,
    catchupCap: 6,
    // The quota is on and starts today, so the day owes exactly postsPerDay.
    quotaStartDate: TODAY,
    digestEmail: false,
    digestWebhookUrl,
  });
  await testDb.insert(publishConnections).values({
    id: "conn_1",
    projectId: PROJECT_ID,
    adapter: "webhook",
    configJson: await encryptedWebhookConfig(),
    status: connectionStatus,
    lastCheckedAt: NOW.toISOString(),
  });
  await testDb.insert(receipts).values(receiptRows(eligible));

  if (pausedReason) {
    await testDb.insert(autopilotState).values({
      id: "state_1",
      projectId: PROJECT_ID,
      consecutiveGateFailures: 3,
      pausedAt: NOW.toISOString(),
      pausedReason,
      updatedAt: NOW.toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// The two things that are faked
// ---------------------------------------------------------------------------

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
  event: string;
};

export const sent: Sent[] = [];

/**
 * The publish target's answer to our credentials.
 *
 * Flipped to `true` this rejects every write event with a 401 while the
 * connection row still says 'ok' — a token revoked after it was last tested,
 * which is the only way an unattended publish ever meets an auth failure. The
 * digest receiver is unaffected: it is a different endpoint with a different
 * secret.
 */
export const publishAuth = { rejects: false };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The whole network: the publish target's webhook receiver, and the digest
 * receiver. Both record every request verbatim — the digest signature proof
 * verifies the exact bytes that went out, so a re-serialized body would be a
 * different document.
 */
export function fakeFetch(): typeof fetch {
  return ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let body: unknown = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    const event = headers["x-rankloop-event"] ?? "";
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers,
      rawBody,
      body,
      event,
    });

    if (url.startsWith(DIGEST_WEBHOOK_URL)) return jsonResponse({ ok: true });
    if (publishAuth.rejects) {
      return jsonResponse({ error: "bad signature" }, 401);
    }
    if (event === "hub.ensure") {
      return jsonResponse({
        ref: "hub-1",
        url: `${SITE_URL}${HUB_PATH}`,
        created: true,
      });
    }
    if (event === "post.get" || event === "page.get") {
      return jsonResponse({ content: USER_PROSE });
    }
    return jsonResponse({ ref: "wh-1", url: `${SITE_URL}/blog/${SLUG}/` });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: every caller only ever calls fetch(url, init)
  }) as unknown as typeof fetch;
}

export function modelResponse(text: string) {
  return {
    text,
    finishReason: "stop",
    usage: { inputTokens: 1000, outputTokens: 800 },
    providerMetadata: { openrouter: { usage: { cost: 0.05 } } },
  };
}

/**
 * The same call, cut off at the token ceiling.
 *
 * `finishReason: 'length'` is what draft.ts reads to land `truncated`, and the
 * cost block is identical to a good call's on purpose: a truncated generation
 * is charged in full. That is the whole reason this class of failure has to be
 * counted — the article is worth nothing and the money is gone either way.
 */
export function truncatedModelResponse() {
  return {
    ...modelResponse(COMPLIANT_DRAFT.slice(0, 300)),
    finishReason: "length",
  };
}
