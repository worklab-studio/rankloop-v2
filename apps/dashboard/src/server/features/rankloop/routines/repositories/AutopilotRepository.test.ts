import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AutopilotRepository as Repository } from "./AutopilotRepository";

// The three queries the unattended loop's ceilings are made of live entirely
// in SQL, and a mocked `db` would assert nothing about any of them. An
// in-memory SQLite speaks the same dialect D1 does, so the due-set guard, the
// day-scoped approval count and the per-proposal failure count are exercised
// against the statements that actually ship — the ReceiptsRepository idiom.
const client = createClient({ url: ":memory:" });
const testDb = drizzle(client);

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));

// Only the tables these queries touch, hand-written rather than replayed from
// drizzle/ — dozens of migrations to reach three SELECTs is a slower test and
// a worse failure message. Column lists mirror src/db/rankloop-write.schema.ts.
const DDL = [
  `create table projects (
     id text primary key,
     archived_at text
   )`,
  `create table writer_settings (
     id text primary key,
     project_id text not null,
     trust_dial text not null default 'titles'
   )`,
  `create table autopilot_state (
     id text primary key,
     project_id text not null,
     consecutive_gate_failures integer not null default 0,
     consecutive_writer_failures integer not null default 0,
     paused_at text,
     paused_reason text,
     updated_at text not null
   )`,
  `create table proposals (
     id text primary key,
     project_id text not null,
     type text not null,
     track text not null,
     status text not null default 'proposed',
     target text not null,
     score real not null,
     decided_at text
   )`,
  `create table articles (
     id text primary key,
     project_id text not null,
     proposal_id text,
     keyword text not null,
     status text not null default 'briefing',
     law_report_json text,
     updated_at text not null
   )`,
];

const LIVE = "project_live";
const ARCHIVED = "project_archived";
const TODAY_START = "2026-08-01T00:00:00.000Z";

let AutopilotRepository: typeof Repository;

async function insertProposal(input: {
  id: string;
  projectId?: string;
  status?: string;
  track?: string;
  type?: string;
  decidedAt?: string | null;
}): Promise<void> {
  await client.execute({
    sql: `insert into proposals
            (id, project_id, type, track, status, target, score, decided_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.projectId ?? LIVE,
      input.type ?? "write_new",
      input.track ?? "net_new",
      input.status ?? "approved",
      `target of ${input.id}`,
      7.2,
      input.decidedAt ?? null,
    ],
  });
}

async function insertArticle(input: {
  id: string;
  proposalId: string;
  status: string;
}): Promise<void> {
  await client.execute({
    sql: `insert into articles
            (id, project_id, proposal_id, keyword, status, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      LIVE,
      input.proposalId,
      "espresso grind size",
      input.status,
      TODAY_START,
    ],
  });
}

beforeAll(async () => {
  for (const statement of DDL) await client.execute(statement);

  await client.execute({
    sql: `insert into projects (id, archived_at) values (?, null), (?, ?)`,
    args: [LIVE, ARCHIVED, "2026-07-20T09:00:00.000Z"],
  });
  for (const projectId of [LIVE, ARCHIVED]) {
    await client.execute({
      sql: `insert into writer_settings (id, project_id, trust_dial)
            values (?, ?, 'autopilot')`,
      args: [`settings_${projectId}`, projectId],
    });
  }

  // Two net-new approvals today and one yesterday, plus a declined row that
  // spent nothing and an optimize row the throttle does not govern.
  await insertProposal({
    id: "today_a",
    decidedAt: "2026-08-01T06:00:00.000Z",
  });
  await insertProposal({
    id: "today_b",
    status: "executing",
    decidedAt: "2026-08-01T06:30:00.000Z",
  });
  await insertProposal({
    id: "yesterday",
    status: "done",
    decidedAt: "2026-07-31T23:59:00.000Z",
  });
  await insertProposal({
    id: "today_declined",
    status: "declined",
    decidedAt: "2026-08-01T06:45:00.000Z",
  });
  await insertProposal({
    id: "today_optimize",
    track: "optimize",
    type: "retitle",
    decidedAt: "2026-08-01T06:50:00.000Z",
  });
  await insertProposal({ id: "archived_work", projectId: ARCHIVED });

  // Two proposals the writer has already been paid to attempt: one has burned
  // both its drafts, one has burned one.
  await insertProposal({ id: "burned", decidedAt: "2026-07-30T06:00:00.000Z" });
  await insertProposal({
    id: "one_left",
    decidedAt: "2026-07-30T07:00:00.000Z",
  });
  await insertArticle({ id: "art_1", proposalId: "burned", status: "failed" });
  await insertArticle({ id: "art_2", proposalId: "burned", status: "failed" });
  await insertArticle({
    id: "art_3",
    proposalId: "one_left",
    status: "failed",
  });

  ({ AutopilotRepository } = await import("./AutopilotRepository"));
});

describe("getAutopilotProjects", () => {
  it("leaves an archived project out of the due-set", async () => {
    const due = await AutopilotRepository.getAutopilotProjects(10);

    expect(due.map((row) => row.projectId)).toEqual([LIVE]);
  });

  it("refuses an archived project even when the dispatcher names it", async () => {
    // The narrowed call the per-project wake makes. Without the join this is
    // the path that keeps a deleted project writing every fifteen minutes.
    expect(await AutopilotRepository.getAutopilotProjects(1, ARCHIVED)).toEqual(
      [],
    );
  });
});

describe("countNetNewApprovedSince", () => {
  it("counts every net-new the day has said yes to, whoever said it", async () => {
    expect(
      await AutopilotRepository.countNetNewApprovedSince(LIVE, TODAY_START),
    ).toBe(2);
  });

  it("does not count a declined row, an optimize row, or yesterday's work", async () => {
    // Four rows carry today's date; only the two net-new yeses spend the
    // day's ceiling. Widening the window to the whole year adds yesterday's
    // `done` net-new and the two burned proposals — the off-by-one this
    // guards is that none of them belong to today.
    const since = await AutopilotRepository.countNetNewApprovedSince(
      LIVE,
      TODAY_START,
    );
    const all = await AutopilotRepository.countNetNewApprovedSince(
      LIVE,
      "2026-01-01T00:00:00.000Z",
    );
    expect(since).toBe(2);
    expect(all).toBe(5);
  });
});

describe("getWritableNetNewProposals", () => {
  it("carries each proposal's failed-draft count, so the run can stop buying", async () => {
    const writable = await AutopilotRepository.getWritableNetNewProposals(
      LIVE,
      10,
    );
    const counts = new Map(
      writable.map((row) => [row.id, row.failedArticles] as const),
    );

    // Both are still returned — the ceiling is the run's to apply and to say
    // out loud, not the query's to hide.
    expect(counts.get("burned")).toBe(2);
    expect(counts.get("one_left")).toBe(1);
    expect(counts.get("today_a")).toBe(0);
  });
});
