import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { symmetricEncrypt } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/libsql";
import { z } from "zod";
import {
  articles,
  contentPages,
  keywordBacklog,
  organization,
  pageTypes,
  projects,
  proposals,
  publishConnections,
  receipts,
  writerSettings,
} from "@/db/schema";

// The world PublishWorkflow.rows.test.ts publishes into: a real SQLite database
// built from the shipped D1 migrations, one project seeded the way a project
// that finished S7b looks, and a `fetch` double per target.
//
// Split out of the test because the proof is the same for all three adapters
// and the assertions are the interesting half. Everything here is fixture; the
// only thing it fakes is the network.

const client = createClient({ url: ":memory:" });
export const testDb = drizzle(client);

// ---------------------------------------------------------------------------
// The database the repositories actually write to
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

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

const ORG_ID = "org_1";
export const PROJECT_ID = "project_1";
const DOMAIN = "beanpress.example";
const SITE_URL = `https://${DOMAIN}`;
const PAGE_TYPE_ID = "type_comparisons";
export const PROPOSAL_ID = "proposal_1";
export const KEYWORD_ID = "kw_1";
export const ARTICLE_ID = "article_1";
export const KEYWORD = "espresso tamper sizes";
export const SLUG = "espresso-tamper-sizes";
export const PATH = `/compare/${SLUG}/`;
export const HUB_PATH = "/compare/";

export const START = "<!-- rankloop:related start -->";
export const END = "<!-- rankloop:related end -->";

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

/**
 * Four neighbours under one page type, so the cap has something to bite on:
 * the selection may only keep three, and a proof that seeded three could not
 * tell "at most three" from "all of them".
 */
export const NEIGHBOURS = [
  { id: "page_a", path: "/compare/tamper-bases/", title: "Tamper bases" },
  { id: "page_b", path: "/compare/tamper-weights/", title: "Tamper weights" },
  { id: "page_c", path: "/compare/tamper-handles/", title: "Tamper handles" },
  { id: "page_d", path: "/compare/tamper-mats/", title: "Tamper mats" },
];

/** The prose on each neighbour. Kept verbatim so the byte-identity assertion
 *  has an exact string to compare against rather than a shape. */
export const USER_PROSE = `# Tampers

Prose the user wrote, and nobody else may touch. Not a plugin, not an
importer, and not rankloop.

[Another post](/compare/tamper-weights/) is linked from here already.
`;

const DRAFT = `---
title: Espresso tamper sizes
description: Which base diameter fits which basket, measured rather than guessed.
date: 2026-08-01
category: Comparisons
keyword: espresso tamper sizes
---

I would measure every basket in the drawer before trusting any of this. The numbers
below are the ones I wrote down, not the ones a manufacturer prints on a box.

## Measure the basket, not the box

Espresso tamper sizes are quoted to a tenth of a millimetre and machined to
rather less than that. Put a caliper across the top of the basket, write the
number down, and buy to the number rather than to the model name on the machine.

## What the gap is telling you

A tamper half a millimetre under leaves a ring of loose grounds at the wall, and
that ring is where the water goes first. The shot runs fast, tastes thin, and no
amount of grinding finer fixes a channel that starts at the edge.

## Which size fits a 58mm basket?

A 58.5mm base, in most of them. The nominal 58 is the portafilter, not the
basket, and the basket is usually a few tenths wider than its own name.

## What I would check next

If two shots in a row still swing, weigh the dose before you blame the tamper.
The [tamper bases](/compare/tamper-bases/) comparison covers the flat-versus-
convex argument, which is the other half of this.
`;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type AdapterKind = "wordpress" | "webhook" | "github";

async function encryptedConfig(adapter: AdapterKind): Promise<string> {
  const shared = { defaultPostStatus: "draft", linkInjection: true };
  const blob =
    adapter === "wordpress"
      ? {
          ...shared,
          baseUrl: SITE_URL,
          username: "editor",
          applicationPassword: "abcd efgh ijkl mnop",
        }
      : adapter === "webhook"
        ? {
            ...shared,
            url: "https://hooks.example/rankloop",
            secret: "a-long-random-string",
            siteUrl: SITE_URL,
          }
        : {
            ...shared,
            owner: "acme",
            repo: "site",
            token: "github_pat_test",
            baseBranch: "main",
            contentDir: "content",
            publicDir: "public",
            commitMode: "pull-request",
            siteUrl: SITE_URL,
          };
  return symmetricEncrypt({
    key: "0123456789abcdef0123456789abcdef",
    data: JSON.stringify(blob),
  });
}

export async function seed(adapter: AdapterKind): Promise<void> {
  for (const table of [
    receipts,
    articles,
    proposals,
    writerSettings,
    publishConnections,
    contentPages,
    keywordBacklog,
    pageTypes,
    projects,
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
  await testDb.insert(projects).values({
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Beanpress",
    domain: DOMAIN,
  });
  await testDb.insert(pageTypes).values({
    id: PAGE_TYPE_ID,
    projectId: PROJECT_ID,
    name: "Comparisons",
    kind: "pseo",
    status: "approved",
    urlPattern: "/compare/{slug}/",
    templateContractJson: JSON.stringify(CONTRACT),
  });
  await testDb.insert(keywordBacklog).values({
    id: KEYWORD_ID,
    projectId: PROJECT_ID,
    keyword: KEYWORD,
    source: "manual",
    category: "Comparisons",
    pageTypeId: PAGE_TYPE_ID,
    status: "queued",
    searchVolume: 320,
    score: 6.4,
  });
  await testDb.insert(contentPages).values(
    NEIGHBOURS.map((neighbour, index) => ({
      id: neighbour.id,
      projectId: PROJECT_ID,
      url: `${SITE_URL}${neighbour.path}`,
      path: neighbour.path,
      kind: "post" as const,
      title: neighbour.title,
      category: "Comparisons",
      pageTypeId: PAGE_TYPE_ID,
      source: "crawl" as const,
      publishedAt: `2026-01-0${index + 1}`,
    })),
  );
  await testDb.insert(proposals).values({
    id: PROPOSAL_ID,
    projectId: PROJECT_ID,
    type: "write_new",
    track: "net_new",
    status: "approved",
    target: KEYWORD,
    pageTypeId: PAGE_TYPE_ID,
    keywordBacklogId: KEYWORD_ID,
    score: 6.4,
  });
  await testDb.insert(writerSettings).values({
    id: "settings_1",
    projectId: PROJECT_ID,
    trustDial: "drafts",
    voiceCardMd: "Blunt, technical, first person.",
  });
  await testDb.insert(articles).values({
    id: ARTICLE_ID,
    projectId: PROJECT_ID,
    proposalId: PROPOSAL_ID,
    pageTypeId: PAGE_TYPE_ID,
    keyword: KEYWORD,
    writerMode: "api",
    status: "approved",
    slug: SLUG,
    title: "Espresso tamper sizes",
    content: DRAFT,
  });
  await testDb.insert(publishConnections).values({
    id: "conn_1",
    projectId: PROJECT_ID,
    adapter,
    configJson: await encryptedConfig(adapter),
  });
}

// ---------------------------------------------------------------------------
// The one thing that is faked
// ---------------------------------------------------------------------------

export type Sent = {
  url: string;
  method: string;
  body: unknown;
  event: string;
};

export const sent: Sent[] = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

const recordShape = z.record(z.string(), z.unknown());

/** One string field off a recorded request body, or "" when it is not there.
 *  Parsed rather than asserted: a request body is data the test read back off
 *  the wire, and reaching into it through a cast would be the one unchecked
 *  step in a proof about exact bytes. */
export function field(body: unknown, key: string): string {
  const parsed = recordShape.safeParse(body);
  const value = parsed.success ? parsed.data[key] : undefined;
  return typeof value === "string" ? value : "";
}

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** WordPress: a site with no hub page, no matching category, and four posts
 *  whose bodies are the user's prose. */
export function wordpressFetch(): typeof fetch {
  const posts = new Map(
    NEIGHBOURS.map((neighbour) => [
      neighbour.path.split("/").filter(Boolean).at(-1) ?? "",
      { id: 100 + NEIGHBOURS.indexOf(neighbour), content: USER_PROSE },
    ]),
  );
  return ((input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: bodyOf(init), event: "" });

    if (url.includes("/wp/v2/pages?slug=")) return jsonResponse([]);
    if (url.endsWith("/wp/v2/pages") && method === "POST") {
      return jsonResponse({ id: 501, link: `${SITE_URL}${HUB_PATH}` });
    }
    if (url.includes("/wp/v2/categories?search=")) return jsonResponse([]);
    if (url.endsWith("/wp/v2/posts") && method === "POST") {
      return jsonResponse({ id: 900, link: `${SITE_URL}${PATH}`, meta: {} });
    }
    if (url.includes("/wp/v2/posts?slug=")) {
      const slug = decodeURIComponent(/slug=([^&]*)/.exec(url)?.[1] ?? "");
      const post = posts.get(slug);
      if (!post) return jsonResponse([]);
      return jsonResponse([
        {
          id: post.id,
          link: `${SITE_URL}/compare/${slug}/`,
          content: { raw: post.content },
        },
      ]);
    }
    const update = /\/wp\/v2\/posts\/(\d+)$/.exec(url);
    if (update && method === "POST") {
      const id = Number(update[1]);
      const entry = [...posts.values()].find((post) => post.id === id);
      const content = field(bodyOf(init), "content");
      if (entry && content) entry.content = content;
      return jsonResponse({ id });
    }
    return jsonResponse({}, 404);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: the adapters only ever call fetch(url, init)
  }) as unknown as typeof fetch;
}

/** Webhook: an endpoint that acknowledges and echoes a ref. */
export function webhookFetch(): typeof fetch {
  return ((input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const event = headers.get("X-Rankloop-Event") ?? "";
    sent.push({
      url: String(input),
      method: "POST",
      body: bodyOf(init),
      event,
    });
    if (event === "hub.ensure") {
      return jsonResponse({
        ref: "hub-1",
        url: `${SITE_URL}${HUB_PATH}`,
        created: true,
      });
    }
    return jsonResponse({ ref: "wh-1", url: `${SITE_URL}${PATH}` });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: the adapters only ever call fetch(url, init)
  }) as unknown as typeof fetch;
}

/** GitHub: a repository with a main branch and four content files. */
export function githubFetch(): typeof fetch {
  const files = new Map<string, string>(
    NEIGHBOURS.map((neighbour) => [
      `content${neighbour.path.replace(/\/$/, "")}.md`,
      USER_PROSE,
    ]),
  );
  const branches = new Set(["main"]);

  return ((input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = bodyOf(init);
    sent.push({ url, method, body, event: "" });

    const ref = /\/git\/ref\/heads\/(.+)$/.exec(url);
    if (ref) {
      const branch = decodeURIComponent(ref[1]);
      return branches.has(branch)
        ? jsonResponse({ object: { sha: `sha-${branch}` } })
        : jsonResponse({ message: "Not Found" }, 404);
    }
    if (url.endsWith("/git/refs") && method === "POST") {
      branches.add(field(body, "ref").replace("refs/heads/", ""));
      return jsonResponse({ ok: true });
    }
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      if (method === "PUT") {
        files.set(
          path,
          Buffer.from(field(body, "content"), "base64").toString("utf8"),
        );
        return jsonResponse({ commit: { sha: "commit-1" } });
      }
      const text = files.get(path);
      if (text === undefined)
        return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse({
        sha: `sha-${path}`,
        content: encode(text),
        encoding: "base64",
      });
    }
    if (url.includes("/pulls?state=open")) return jsonResponse([]);
    if (url.endsWith("/pulls") && method === "POST") {
      return jsonResponse({
        number: 7,
        html_url: "https://github.com/acme/site/pull/7",
      });
    }
    return jsonResponse({}, 404);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: the adapters only ever call fetch(url, init)
  }) as unknown as typeof fetch;
}

/** What the target holds for a neighbour after the run — the bytes the owned
 *  block proof reads. */
export function bodiesWritten(): string[] {
  return sent
    .filter((call) => call.method === "POST" || call.method === "PUT")
    .flatMap((call) => {
      const wp = field(call.body, "content");
      if (/\/wp\/v2\/posts\/\d+$/.test(call.url)) return [wp];
      if (call.url.includes("/contents/") && call.method === "PUT") {
        return [Buffer.from(wp, "base64").toString("utf8")];
      }
      return [];
    });
}
