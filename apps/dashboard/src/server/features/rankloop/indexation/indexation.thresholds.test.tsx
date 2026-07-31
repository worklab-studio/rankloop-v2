import { createClient } from "@libsql/client";
import type { InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Spec 0022 acceptance 2 and 3, end to end on seeded rows rather than on
// hand-fed inputs: real content_pages and indexation_checks in an in-memory
// SQLite (the dialect D1 speaks), read by the real repository SQL, reduced by
// the real rate function, capped by the real quota arithmetic, and then
// painted by the real components. The unit files either side of this one each
// prove one link; this one proves the chain, which is where two halves of a
// feature written by two people actually disagree.
//
// A .test.tsx because the last link is markup — the whole point is that the
// number the throttle obeyed and the sentence the operator reads come out of
// the same seeded rows, so splitting them across two files would leave the
// join untested. react-dom/server needs no DOM, so this stays in vitest's
// node environment like everything else here.

const client = createClient({ url: ":memory:" });
const testDb = drizzle(client);

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));
// The rate is a fact about stored checks; the connection only decides which
// of the two null copies the card shows, and every project below has one.
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getConnection: () => Promise.resolve({ siteUrl: "sc-domain:acme.com" }),
  },
}));

// Only the tables the two reads touch, hand-written for the same reason
// ReceiptsRepository.test.ts does it: replaying 50 migrations to reach two
// SELECTs is a slower test with a worse failure message.
const DDL = [
  `create table projects (id text primary key, archived_at text)`,
  `create table content_pages (
     id text primary key,
     project_id text not null,
     url text not null,
     path text not null,
     kind text not null,
     published_at text,
     source text not null
   )`,
  `create table indexation_checks (
     id integer primary key autoincrement,
     project_id text not null,
     url text not null,
     verdict text not null,
     coverage_state text,
     checked_at text not null
   )`,
];

// Pinned so the 7–45 day cohort window is arithmetic a reader can check:
// published between 2026-06-17 and 2026-07-25 inclusive.
const TODAY = "2026-08-01";
const IN_COHORT = "2026-07-01";
const TOO_YOUNG = "2026-07-30";
const CHECKED_AT = "2026-07-28T09:00:00.000Z";

/** One published post plus its latest verdict. `verdict: null` seeds a post
 *  the daily job has not reached yet — published, but not in the denominator. */
function seedPage(
  projectId: string,
  n: number,
  verdict: string | null,
  publishedAt = IN_COHORT,
) {
  const url = `https://acme.com/${projectId}/post-${n}/`;
  const rows: InStatement[] = [
    {
      sql: `insert into content_pages
              (id, project_id, url, path, kind, published_at, source)
            values (?, ?, ?, ?, 'post', ?, 'publish')`,
      args: [`${projectId}_${n}`, projectId, url, `/post-${n}/`, publishedAt],
    },
  ];
  if (verdict !== null) {
    rows.push({
      sql: `insert into indexation_checks
              (project_id, url, verdict, coverage_state, checked_at)
            values (?, ?, ?, ?, ?)`,
      args: [
        projectId,
        url,
        verdict,
        verdict === "PASS" ? "Submitted and indexed" : null,
        CHECKED_AT,
      ],
    });
  }
  return rows;
}

/** `indexed` PASSes and `total - indexed` FAILs, all inside the window. */
function seedCohort(projectId: string, total: number, indexed: number) {
  const rows: InStatement[] = [
    {
      sql: `insert into projects (id, archived_at) values (?, null)`,
      args: [projectId],
    },
  ];
  for (let n = 0; n < total; n++) {
    rows.push(...seedPage(projectId, n, n < indexed ? "PASS" : "FAIL"));
  }
  return rows;
}

const HEALTHY = "project_healthy";
const HELD = "project_held";
const PAUSED = "project_paused";
const YOUNG = "project_young";

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  for (const sql of DDL) await client.execute(sql);
  await client.batch([
    // 18 of 20 indexed — nothing to hold back.
    ...seedCohort(HEALTHY, 20, 18),
    // 13 of 25 indexed = 52%: under 65, over 40.
    ...seedCohort(HELD, 25, 13),
    // 6 of 20 indexed = 30%: under 40.
    ...seedCohort(PAUSED, 20, 6),
    // Four posts, all indexed. Four is not evidence.
    ...seedCohort(YOUNG, 4, 4),
    // Noise that must not move any of the four numbers above.
    // A post published two days ago and refused — too young to judge, and
    // counting it would read crawl latency as a failure.
    ...seedPage(HELD, 900, "FAIL", TOO_YOUNG),
    // A post published outside the far edge of the window.
    ...seedPage(HELD, 901, "FAIL", "2026-05-02"),
    // A cohort post nobody has inspected yet: published, unchecked, and out of
    // the denominator rather than counted as a rejection.
    ...seedPage(HELD, 902, null),
    // A page that was on the site before rankloop: crawled, not published.
    {
      sql: `insert into content_pages
              (id, project_id, url, path, kind, published_at, source)
            values ('legacy_1', ?, 'https://acme.com/legacy/', '/legacy/',
                    'post', ?, 'crawl')`,
      args: [HELD, IN_COHORT],
    },
    // An older verdict for post-0, which has since been indexed. Latest wins,
    // so this must not drag the rate down.
    {
      sql: `insert into indexation_checks
              (project_id, url, verdict, coverage_state, checked_at)
            values (?, ?, 'FAIL', 'Crawled - currently not indexed',
                    '2026-07-10T09:00:00.000Z')`,
      args: [HELD, `https://acme.com/${HELD}/post-0/`],
    },
  ]);
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  cardData: null as unknown,
  quotaData: null as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    isPending: false,
    isError: false,
    data:
      queryKey[0] === "rankloopIndexation" ? mocks.cardData : mocks.quotaData,
  }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({
  toast: { info: () => {}, success: () => {}, error: () => {} },
}));
vi.mock("@/serverFunctions/rankloopIndexation", () => ({
  getRankloopIndexation: () => Promise.resolve(null),
}));
vi.mock("@/serverFunctions/rankloopWriting", () => ({
  getRankloopWritingQuota: () => Promise.resolve(null),
  proposeRankloopNetNew: () => Promise.resolve(null),
}));

/** The dashboard's Indexation card, as this project's stored checks paint it. */
async function renderCard(summary: unknown): Promise<string> {
  mocks.cardData = summary;
  const { IndexationCard } =
    await import("@/client/features/dashboard/IndexationCard");
  return renderToStaticMarkup(<IndexationCard projectId="project_1" />);
}

/** The Articles header, as the throttled quota paints it. `exclusions` is the
 *  only field the bar reads that the slots calculation does not produce. */
async function renderQuotaBar(quota: {
  owed: number | null;
  outstanding: number;
  reason: string | null;
  throttle: { cap: number; reason: string } | null;
}): Promise<string> {
  mocks.quotaData = { ...quota, exclusions: [] };
  const { RankloopQuotaBar } =
    await import("@/client/features/rankloop-articles/RankloopQuotaBar");
  return renderToStaticMarkup(<RankloopQuotaBar projectId="project_1" />);
}

// ---------------------------------------------------------------------------
// The four branches
// ---------------------------------------------------------------------------

/** Two a day, starting today: the engine owes 2 before any cap. */
const SETTINGS = {
  postsPerDay: 2,
  catchupCap: 6,
  quotaStartDate: TODAY,
};

/** Status from the seeded rows, then the slots that status allows — the exact
 *  two calls NetNewProposalsService.readQuota makes, in the same order. */
async function statusAndSlots(projectId: string) {
  const { IndexationService } =
    await import("@/server/features/rankloop/indexation/services/IndexationService");
  const { computeNetNewSlots } =
    await import("@/server/features/rankloop/writing/selection");
  const status = await IndexationService.getIndexationStatus(projectId);
  const quota = computeNetNewSlots({
    settings: SETTINGS,
    publishedDates: [],
    outstanding: 0,
    today: TODAY,
    throttle: status.throttle,
  });
  return { status, quota };
}

describe("indexation thresholds, from seeded rows to painted copy", () => {
  it("healthy: 90% indexed takes no cap and says nothing about a throttle", async () => {
    const { status, quota } = await statusAndSlots(HEALTHY);

    expect(status.rate).toBe(0.9);
    expect(status.throttle).toBeNull();
    expect(quota.slots).toBe(2);
    expect(quota.owed).toBe(2);

    const card = await renderCard(status);
    expect(card).toContain("90%");
    expect(card).toContain(
      "18 of 20 posts published 7–45 days ago are indexed · checked daily",
    );
    expect(card).not.toContain("quota held");
    expect(card).not.toContain("net-new paused");

    const header = await renderQuotaBar(quota);
    expect(header).toContain("2 owed today");
    expect(header).not.toContain("indexed");
  });

  it("52%: the quota is held at 1 and both surfaces say why", async () => {
    const { status, quota } = await statusAndSlots(HELD);

    // 13 PASS of 25 checked cohort posts. The out-of-window posts, the
    // unchecked one, the crawled legacy page and post-0's stale FAIL are all
    // seeded above and none of them are in this number.
    expect(status).toMatchObject({ rate: 0.52, indexed: 13, cohort: 25 });
    expect(status.throttle).toEqual({
      cap: 1,
      reason: "quota held at 1 — 52% of recent posts are indexed",
    });
    // The engine still owes 2; the cap is a ceiling over its answer.
    expect(quota.owed).toBe(2);
    expect(quota.slots).toBe(1);

    const card = await renderCard(status);
    expect(card).toContain("52%");
    expect(card).toContain("quota held at 1");
    expect(card).toContain(
      "13 of 25 posts published 7–45 days ago are indexed",
    );

    const header = await renderQuotaBar(quota);
    expect(header).toContain(
      "quota held at 1 — 52% of recent posts are indexed",
    );
    // The arithmetic survives underneath rather than being replaced by it.
    expect(header).toContain("2 owed today");
  });

  it("30%: net-new is paused, and the pause is the sentence on both screens", async () => {
    const { status, quota } = await statusAndSlots(PAUSED);

    expect(status).toMatchObject({ rate: 0.3, indexed: 6, cohort: 20 });
    expect(status.throttle).toEqual({
      cap: 0,
      reason: "net-new paused — 30% of recent posts are indexed",
    });
    expect(quota.owed).toBe(2);
    expect(quota.slots).toBe(0);
    expect(quota.reason).toBe(
      "net-new paused — 30% of recent posts are indexed",
    );

    const card = await renderCard(status);
    expect(card).toContain("30%");
    expect(card).toContain("net-new paused");

    const header = await renderQuotaBar(quota);
    expect(header).toContain(
      "net-new paused — 30% of recent posts are indexed",
    );
  });

  it("a 4-post cohort concludes nothing, caps nothing, and says it needs 5", async () => {
    const { status, quota } = await statusAndSlots(YOUNG);

    // Four of four indexed is not 100% — it is no evidence.
    expect(status.rate).toBeNull();
    expect(status.cohort).toBe(4);
    expect(status.minimumCohort).toBe(5);
    expect(status.throttle).toBeNull();
    expect(quota.slots).toBe(2);

    const card = await renderCard(status);
    expect(card).toContain("—");
    expect(card).toContain("not enough published posts yet to judge — needs 5");
    expect(card).not.toContain("100%");
    expect(card).not.toContain("quota held");

    const header = await renderQuotaBar(quota);
    expect(header).toContain("2 owed today");
  });
});
