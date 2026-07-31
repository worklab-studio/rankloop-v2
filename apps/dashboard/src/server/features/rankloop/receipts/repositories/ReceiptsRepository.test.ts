import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ReceiptsRepository as Repository } from "./ReceiptsRepository";

// The due-check is the one piece of receipt behavior that lives entirely in
// SQL, and a mocked `db` would assert nothing about it. An in-memory SQLite
// speaks the same dialect D1 does, so the starvation guards below are exercised
// against the statement that actually ships.
const client = createClient({ url: ":memory:" });
const testDb = drizzle(client);

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));

// Only the three tables the due query touches, hand-written rather than
// replayed from drizzle/ — 43 migrations to reach one SELECT is a slower test
// and a worse failure message. Column lists mirror
// src/db/rankloop-write.schema.ts / rankloop-data.schema.ts.
const DDL = [
  `create table projects (
     id text primary key,
     archived_at text
   )`,
  `create table gsc_performance (
     id integer primary key autoincrement,
     project_id text not null,
     page_id text not null,
     query_id text not null,
     date text not null,
     grain text not null default 'day',
     clicks integer not null,
     impressions integer not null,
     ctr real not null,
     position real not null
   )`,
  `create table receipts (
     id text primary key,
     project_id text not null,
     action_type text not null,
     article_id text,
     content_page_id text,
     target_query text,
     status text not null default 'baseline',
     baseline_json text,
     result_json text,
     window_start text,
     window_end text,
     measured_at text,
     next_check_at text,
     created_at text not null
   )`,
];

// Every receipt below shares one closed window: opened 2026-06-03, closed
// 2026-07-01, so on 2026-07-20 all of them are past windowEnd.
const WINDOW_START = "2026-06-03";
const WINDOW_END = "2026-07-01";
const TODAY = "2026-07-20";
const TOMORROW = "2026-07-21";

/** How many rows one measurement pass asks for — the cap the starved query
 *  used to fill entirely with un-advanceable rows. */
const PASS_LIMIT = 50;

function insertReceipt(
  id: string,
  projectId: string,
  createdAt: string,
  nextCheckAt: string | null,
) {
  return {
    sql: `insert into receipts
            (id, project_id, action_type, content_page_id, status,
             window_start, window_end, next_check_at, created_at)
          values (?, ?, 'retitle', 'page_1', 'measuring', ?, ?, ?, ?)`,
    args: [id, projectId, WINDOW_START, WINDOW_END, nextCheckAt, createdAt],
  };
}

function insertWatermark(projectId: string, date: string) {
  return {
    sql: `insert into gsc_performance
            (project_id, page_id, query_id, date, grain, clicks, impressions, ctr, position)
          values (?, 'page_1', 'query_1', ?, 'day', 1, 10, 0.1, 4.0)`,
    args: [projectId, date],
  };
}

// Imported dynamically below: the "@/db" mock factory closes over `testDb`,
// which only exists once this module's body has run.
let ReceiptsRepository: typeof Repository;

beforeAll(async () => {
  for (const statement of DDL) await client.execute(statement);

  const rows = [
    // Project A is live but its sync has stalled: memory sits a month behind
    // the windowEnd it would have to reach. Its 59 receipts can never advance,
    // and being the oldest they own every slot in the pass.
    {
      sql: "insert into projects (id, archived_at) values ('project_a', null)",
    },
    {
      sql: "insert into projects (id, archived_at) values ('project_b', null)",
    },
    {
      sql: "insert into projects (id, archived_at) values ('project_c', '2026-05-01T00:00:00.000Z')",
    },
    insertWatermark("project_a", "2026-06-01"),
    insertWatermark("project_b", "2026-08-01"),
    insertWatermark("project_c", "2026-08-01"),
    // The one receipt that CAN transition today, deliberately the youngest.
    insertReceipt("receipt_b", "project_b", "2026-06-10T00:00:00.000Z", null),
    // Same project, already deferred to tomorrow by an earlier pass.
    insertReceipt(
      "receipt_b_deferred",
      "project_b",
      "2026-06-11T00:00:00.000Z",
      TOMORROW,
    ),
    // An archived project's receipts are immortal by design: archiveProject is
    // a soft delete and the GSC due-query skips archived projects forever.
    insertReceipt("receipt_c", "project_c", "2026-06-12T00:00:00.000Z", null),
  ];
  for (let i = 0; i < 59; i++) {
    const created = `2026-05-01T00:00:${String(i).padStart(2, "0")}.000Z`;
    rows.push(insertReceipt(`receipt_a_${i}`, "project_a", created, null));
  }
  await client.batch(rows, "write");

  ({ ReceiptsRepository } = await import("./ReceiptsRepository"));
});

describe("getDueReceipts", () => {
  it("never lets a project with frozen memory eat the whole pass", async () => {
    const due = await ReceiptsRepository.getDueReceipts(TODAY, PASS_LIMIT);

    expect(due.map((receipt) => receipt.id)).toEqual(["receipt_b"]);
  });

  it("excludes receipts deferred to a later day, and returns them once it arrives", async () => {
    const today = await ReceiptsRepository.getDueReceipts(TODAY, PASS_LIMIT);
    expect(today.map((receipt) => receipt.id)).not.toContain(
      "receipt_b_deferred",
    );

    const tomorrow = await ReceiptsRepository.getDueReceipts(
      TOMORROW,
      PASS_LIMIT,
    );
    expect(tomorrow.map((receipt) => receipt.id)).toContain(
      "receipt_b_deferred",
    );
  });

  it("excludes receipts owned by an archived project", async () => {
    // A limit wide enough to hold every fixture row, so the archived project's
    // receipt is excluded by the join and not merely by the cap.
    const due = await ReceiptsRepository.getDueReceipts(TODAY, 100);

    expect(due.map((receipt) => receipt.projectId)).not.toContain("project_c");
  });
});
