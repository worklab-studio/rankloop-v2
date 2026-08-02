import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LawReport } from "@/server/features/rankloop/writing/gate";

// The editor's "Save & re-check", against the real gate. Everything the laws
// read is real here — the engine, the contract merge, the site's pages — so
// the thing being proved is the one the spec cares about: a hand edit is
// re-graded for nothing, and no model is anywhere near it.

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  articleRepo: {
    getArticleById: vi.fn(),
    // Typed so `.mock.calls` below reads without an unsafe cast.
    updateArticle:
      vi.fn<
        (articleId: string, update: Record<string, unknown>) => Promise<void>
      >(),
    insertSpend: vi.fn(),
  },
  briefRepo: { getLinkablePages: vi.fn() },
  pagePlanRepo: { getPageTypeById: vi.fn(), getPageTypes: vi.fn() },
  projectRepo: { getProjectById: vi.fn() },
  settingsRepo: { getSettings: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock(
  "@/server/features/rankloop/writing/repositories/ArticleRepository",
  () => ({ ArticleRepository: mocks.articleRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/BriefRepository",
  () => ({ BriefRepository: mocks.briefRepo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: mocks.settingsRepo }),
);
vi.mock(
  "@/server/features/rankloop/page-plan/repositories/PagePlanRepository",
  () => ({ PagePlanRepository: mocks.pagePlanRepo }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: mocks.projectRepo,
}));

const { ArticleGateService } = await import("./ArticleGateService");

// ---------------------------------------------------------------------------
// A draft that actually clears the house laws
// ---------------------------------------------------------------------------

// 15 words a repetition, so the body clears the 850-word floor without
// tripping the banned-phrase list, the em-dash ban or the density ceiling.
const PARAGRAPH =
  "The grind setting changes how much coffee stays inside the chamber after every single dose.";

function paragraphs(count: number): string {
  return Array.from({ length: count }, () => PARAGRAPH).join(" ");
}

function compliantDraft(): string {
  return [
    "---",
    "title: What burr grinder retention costs you",
    "description: I weighed doses for a month to see how much coffee a grinder keeps.",
    "date: 2026-08-01",
    "category: Comparisons",
    "keyword: burr grinder retention",
    "---",
    "",
    `I weigh every dose, and burr grinder retention is what the scale keeps finding. ${paragraphs(12)}`,
    "",
    "## How I would measure it",
    "",
    paragraphs(12),
    "",
    "## What the numbers changed about my routine",
    "",
    `My routine now starts with a purge. See [dose consistency](/blog/dose-consistency/) and [grinder basics](/blog/grinder-basics/) for the rest. ${paragraphs(12)}`,
    "",
    "## Does burr grinder retention matter for espresso?",
    "",
    paragraphs(12),
    "",
    "## How do I measure retention at home?",
    "",
    paragraphs(12),
    "",
    "## Is a single dosing workflow worth it?",
    "",
    paragraphs(12),
  ].join("\n");
}

/** The same draft with a banned phrase and a link to a page that is not there:
 *  spec 0020's scenario (b), by hand. */
function violatingDraft(): string {
  return compliantDraft()
    .replace("My routine now starts with a purge.", "Let's explore the purge.")
    .replace("/blog/grinder-basics/", "/blog/grinder-myths/");
}

const ARTICLE = {
  id: "article_1",
  projectId: "project_1",
  proposalId: "proposal_1",
  pageTypeId: "type_1",
  keyword: "burr grinder retention",
  status: "failed",
  title: null,
  attempts: 3,
};

function storedReport(): LawReport {
  const patch = mocks.articleRepo.updateArticle.mock.calls
    .map((call) => call[1])
    .findLast((update) => "lawReportJson" in update);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column is written by the service under test from a LawReport
  return JSON.parse(String(patch?.lawReportJson)) as LawReport;
}

beforeEach(() => {
  for (const mock of Object.values(mocks.articleRepo)) mock.mockReset();
  mocks.generateText.mockReset();
  mocks.briefRepo.getLinkablePages.mockReset();
  mocks.pagePlanRepo.getPageTypeById.mockReset();
  mocks.pagePlanRepo.getPageTypes.mockReset();
  mocks.projectRepo.getProjectById.mockReset();
  mocks.settingsRepo.getSettings.mockReset();

  mocks.articleRepo.getArticleById.mockResolvedValue(ARTICLE);
  mocks.articleRepo.updateArticle.mockResolvedValue(undefined);
  mocks.projectRepo.getProjectById.mockResolvedValue({
    id: "project_1",
    organizationId: "org_1",
    name: "Acme Coffee",
    domain: "acme.coffee",
  });
  mocks.pagePlanRepo.getPageTypeById.mockResolvedValue({
    id: "type_1",
    name: "Comparisons",
    templateContractJson: null,
    urlPattern: "/blog/",
  });
  mocks.pagePlanRepo.getPageTypes.mockResolvedValue([
    { id: "type_1", name: "Comparisons", status: "approved" },
    { id: "type_2", name: "Guides", status: "approved" },
  ]);
  mocks.briefRepo.getLinkablePages.mockResolvedValue([
    {
      path: "/blog/dose-consistency",
      title: "Dose consistency",
      category: "Guides",
    },
    {
      path: "/blog/grinder-basics",
      title: "Grinder basics",
      category: "Guides",
    },
  ]);
  mocks.settingsRepo.getSettings.mockResolvedValue({ trustDial: "drafts" });
});

describe("recheck", () => {
  it("re-grades a hand edit without a model call and without a ledger row", async () => {
    const result = await ArticleGateService.recheck({
      projectId: "project_1",
      articleId: "article_1",
      content: compliantDraft(),
    });

    // The whole point of the editor: fixing a sentence costs nothing.
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.articleRepo.insertSpend).not.toHaveBeenCalled();
    expect(result).toEqual({ passed: true, failedCount: 0, status: "review" });

    // No attempt was spent, so the count must not move.
    for (const call of mocks.articleRepo.updateArticle.mock.calls) {
      expect(call[1]).not.toHaveProperty("attempts");
    }
  });

  it("stores every law, passes included, and the title the laws measured", async () => {
    await ArticleGateService.recheck({
      projectId: "project_1",
      articleId: "article_1",
      content: compliantDraft(),
    });

    const report = storedReport();
    expect(report.passed).toBe(true);
    expect(report.violations).toBe(0);
    // The receipt lists what passed; a report of failures alone proves nothing.
    expect(report.laws.length).toBeGreaterThan(10);
    expect(report.laws.every((law) => law.passed)).toBe(true);

    expect(mocks.articleRepo.updateArticle).toHaveBeenCalledWith(
      "article_1",
      expect.objectContaining({
        title: "What burr grinder retention costs you",
        slug: "what-burr-grinder-retention-costs-you",
      }),
    );
  });

  it("moves a draft back to failed when an edit breaks a law, quoting the text", async () => {
    const result = await ArticleGateService.recheck({
      projectId: "project_1",
      articleId: "article_1",
      content: violatingDraft(),
    });

    expect(result).toMatchObject({ passed: false, status: "failed" });
    expect(result.failedCount).toBe(2);

    const report = storedReport();
    const failed = report.laws.filter((law) => !law.passed);
    expect(failed.map((law) => law.id).toSorted()).toEqual([
      "bannedPhrases",
      "internalLinksMin",
    ]);
    // Both failures point at the draft's own words, not at a law name.
    const byId = new Map(failed.map((law) => [law.id, law]));
    expect(byId.get("bannedPhrases")?.excerpt).toContain("Let's explore");
    expect(byId.get("internalLinksMin")?.excerpt).toBe("/blog/grinder-myths/");
  });

  it("auto-approves a hand-fixed draft when the trust dial is titles", async () => {
    mocks.settingsRepo.getSettings.mockResolvedValue({ trustDial: "titles" });

    const result = await ArticleGateService.recheck({
      projectId: "project_1",
      articleId: "article_1",
      content: compliantDraft(),
    });

    expect(result.status).toBe("approved");
  });

  it("refuses to edit an article that is already past the draft stage", async () => {
    mocks.articleRepo.getArticleById.mockResolvedValue({
      ...ARTICLE,
      status: "published",
    });

    await expect(
      ArticleGateService.recheck({
        projectId: "project_1",
        articleId: "article_1",
        content: compliantDraft(),
      }),
    ).rejects.toThrow("past the point where the draft can be edited");
  });
});
