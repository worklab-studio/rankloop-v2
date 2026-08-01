import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WriterSettingsRepository as Repository } from "./WriterSettingsRepository";

// The archived-project exclusion is a join predicate and nothing else, so a
// mocked `db` would assert only that the mock was called. In-memory SQLite
// speaks D1's dialect, which makes this a test of the statement that ships.
const client = createClient({ url: ":memory:" });
const testDb = drizzle(client);

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));

// Only the two tables the due-set read touches, and only the columns it
// selects — hand-written for the same reason ReceiptsRepository.test.ts does
// it: replaying every migration to reach one SELECT is slower and its failures
// say less. Column lists mirror src/db/rankloop-write.schema.ts.
const DDL = [
  `create table projects (
     id text primary key,
     archived_at text
   )`,
  `create table writer_settings (
     id text primary key,
     project_id text not null unique,
     posts_per_day integer not null default 2,
     catchup_cap integer not null default 6,
     quota_start_date text
   )`,
];

function insertSettings(projectId: string) {
  return {
    sql: `insert into writer_settings
            (id, project_id, posts_per_day, catchup_cap, quota_start_date)
          values (?, ?, 2, 6, '2026-07-01')`,
    args: [`settings_${projectId}`, projectId],
  };
}

// Imported dynamically below: the "@/db" mock factory closes over `testDb`,
// which only exists once this module's body has run.
let WriterSettingsRepository: typeof Repository;

beforeAll(async () => {
  for (const statement of DDL) await client.execute(statement);

  await client.batch(
    [
      { sql: "insert into projects (id, archived_at) values ('live', null)" },
      {
        sql: "insert into projects (id, archived_at) values ('archived', '2026-05-01T00:00:00.000Z')",
      },
      // Both have the quota switched on, which is what keeps a project in the
      // net-new due set: the difference between them is only the soft delete.
      insertSettings("live"),
      insertSettings("archived"),
    ],
    "write",
  );

  ({ WriterSettingsRepository } = await import("./WriterSettingsRepository"));
});

describe("getAllSettings", () => {
  it("keeps a live project with the quota on", async () => {
    const rows = await WriterSettingsRepository.getAllSettings();

    expect(rows.map((row) => row.projectId)).toEqual(["live"]);
    expect(rows[0]).toMatchObject({ postsPerDay: 2, catchupCap: 6 });
  });

  it("drops an archived project from the sweep's due set", async () => {
    const rows = await WriterSettingsRepository.getAllSettings();

    expect(rows.map((row) => row.projectId)).not.toContain("archived");
  });

  it("drops an archived project from its own dispatcher's read too", async () => {
    // The narrowed read is the path a project's own 15-minute alarm takes, and
    // on self-host it is the only dispatcher there is — filtering the sweep
    // alone would leave the archived project running everywhere it matters.
    const rows = await WriterSettingsRepository.getAllSettings("archived");

    expect(rows).toEqual([]);
  });

  it("still narrows to the one live project it was asked for", async () => {
    const rows = await WriterSettingsRepository.getAllSettings("live");

    expect(rows.map((row) => row.projectId)).toEqual(["live"]);
  });
});
