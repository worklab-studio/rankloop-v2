import { beforeAll, describe, expect, it, vi } from "vitest";

// This one predicate is the difference between a project staying in the
// scheduled flywheel and dropping out of it forever, and it is expressed
// entirely in SQL — an assertion on the generated query text would pass just
// as happily on a predicate that means the opposite. So the three due-queries
// run for real here, against an in-memory SQLite (node:sqlite, no new
// dependency) wired into Drizzle through its sqlite-proxy driver. The tables
// are the narrow slice each query touches.
type BindValue = string | number | bigint | null;

const harness = vi.hoisted(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { drizzle } = await import("drizzle-orm/sqlite-proxy");
  const sqlite = new DatabaseSync(":memory:");
  const db = drizzle(
    async (query: string, params: unknown[], method: string) => {
      const statement = sqlite.prepare(query);
      const values = params.map((param): BindValue => {
        if (
          param === null ||
          typeof param === "string" ||
          typeof param === "number" ||
          typeof param === "bigint"
        ) {
          return param;
        }
        throw new Error(`Unbindable test parameter of type ${typeof param}`);
      });
      if (method === "run") {
        statement.run(...values);
        return { rows: [] };
      }
      const rows = statement.all(...values).map((row) => Object.values(row));
      return method === "get" ? { rows: rows[0] ?? [] } : { rows };
    },
  );
  return { sqlite, db };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", async () => ({ db: (await harness).db }));

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** ISO-8601, the shape Postgres' timestamp default writes. */
function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/** "YYYY-MM-DD HH:MM:SS", the shape SQLite's current_timestamp writes — the
 *  default self-host path, and the one a naive text comparison misreads. */
function d1Stamp(msAgo: number): string {
  return iso(msAgo).replace("T", " ").slice(0, 19);
}

beforeAll(async () => {
  const { sqlite } = await harness;
  sqlite.exec(`
    create table projects (id text primary key, archived_at text);
    create table gsc_connections (project_id text);
    create table gsc_performance (project_id text, date text, grain text);
    create table gsc_sync_runs (project_id text, status text, started_at text);
    create table site_study_runs (
      project_id text, status text, started_at text, finished_at text
    );
    create table competitors (
      id text primary key, project_id text, domain text, status text,
      last_studied_at text
    );
    create table competitor_study_runs (
      competitor_id text, status text, started_at text
    );
  `);
});

describe("isYoungActiveRun in getProjectsDueForSync", () => {
  it("keeps a project with a fresh sync out and lets a wedged one back in", async () => {
    const { sqlite } = await harness;
    sqlite.exec(`
      insert into projects (id, archived_at) values
        ('sync_free', null), ('sync_live', null),
        ('sync_wedged', null), ('sync_live_d1', null);
      insert into gsc_connections (project_id) values
        ('sync_free'), ('sync_live'), ('sync_wedged'), ('sync_live_d1');
    `);
    const insertRun = sqlite.prepare(
      "insert into gsc_sync_runs (project_id, status, started_at) values (?, ?, ?)",
    );
    insertRun.run("sync_live", "running", iso(5 * MINUTE_MS));
    // The stranded row: its workflow instance died in a deploy three hours
    // ago and nothing user-triggered will ever probe it on self-host.
    insertRun.run("sync_wedged", "pending", iso(3 * HOUR_MS));
    insertRun.run("sync_live_d1", "running", d1Stamp(5 * MINUTE_MS));
    const { GscSyncRepository } =
      await import("@/server/features/rankloop/gsc-sync/repositories/GscSyncRepository");

    const due = await GscSyncRepository.getProjectsDueForSync("2026-07-01", 10);

    expect(due.map((row) => row.projectId).toSorted()).toEqual([
      "sync_free",
      "sync_wedged",
    ]);
  });
});

describe("isYoungActiveRun in getProjectsDueForStudy", () => {
  it("keeps a project with a fresh study out and lets a wedged one back in", async () => {
    const { sqlite } = await harness;
    sqlite.exec(`
      insert into projects (id, archived_at) values
        ('study_free', null), ('study_live', null), ('study_wedged', null);
    `);
    const insertRun = sqlite.prepare(
      "insert into site_study_runs (project_id, status, started_at, finished_at) values (?, ?, ?, ?)",
    );
    // Every project studied a fortnight ago, so all three are past the
    // weekly cadence — only the active-run exclusion separates them.
    for (const projectId of ["study_free", "study_live", "study_wedged"]) {
      insertRun.run(
        projectId,
        "done",
        iso(15 * 24 * HOUR_MS),
        iso(14 * 24 * HOUR_MS),
      );
    }
    insertRun.run("study_live", "running", iso(10 * MINUTE_MS), null);
    insertRun.run("study_wedged", "running", iso(6 * HOUR_MS), null);
    const { SiteStudyRepository } =
      await import("@/server/features/rankloop/site-study/repositories/SiteStudyRepository");

    const due = await SiteStudyRepository.getProjectsDueForStudy(
      iso(7 * 24 * HOUR_MS),
      10,
    );

    expect(due.map((row) => row.projectId).toSorted()).toEqual([
      "study_free",
      "study_wedged",
    ]);
  });
});

describe("isYoungActiveRun in getCompetitorsDueForRefresh", () => {
  it("keeps a competitor with a fresh study out and lets a wedged one back in", async () => {
    const { sqlite } = await harness;
    sqlite.exec(`
      insert into projects (id, archived_at) values ('comp_project', null);
      insert into competitors (id, project_id, domain, status, last_studied_at)
        values
        ('c_free', 'comp_project', 'free.com', 'tracked', '2026-01-01T00:00:00.000Z'),
        ('c_live', 'comp_project', 'live.com', 'tracked', '2026-01-01T00:00:00.000Z'),
        ('c_wedged', 'comp_project', 'wedged.com', 'tracked', '2026-01-01T00:00:00.000Z');
    `);
    const insertRun = sqlite.prepare(
      "insert into competitor_study_runs (competitor_id, status, started_at) values (?, ?, ?)",
    );
    insertRun.run("c_live", "running", iso(20 * MINUTE_MS));
    insertRun.run("c_wedged", "running", iso(4 * HOUR_MS));
    const { CompetitorsRepository } =
      await import("@/server/features/rankloop/competitors/repositories/CompetitorsRepository");

    const due = await CompetitorsRepository.getCompetitorsDueForRefresh(
      iso(30 * 24 * HOUR_MS),
      10,
    );

    expect(due.map((row) => row.id).toSorted()).toEqual(["c_free", "c_wedged"]);
  });
});
