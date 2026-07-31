import { score } from "@rankloop/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toEngineConfig } from "@/server/features/rankloop/universe/gate.logic";
import { readImpressions28 } from "@/server/features/rankloop/universe/notes.logic";
import type { BacklogUpsert } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import type { UniverseCandidate } from "./keywordAdmission";

const mocks = vi.hoisted(() => ({
  gate: { loadEngineConfig: vi.fn() },
  repo: {
    getBacklogKeywordNotes: vi.fn(),
    upsertBacklogRows:
      vi.fn<(projectId: string, rows: BacklogUpsert[]) => Promise<void>>(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/universe/repositories/UniverseRepository",
  () => ({ UniverseRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/universe/services/RelevanceGateService",
  () => ({ RelevanceGateService: mocks.gate }),
);

const { admitAndStore, admitCandidates, imputeVolume } =
  await import("./keywordAdmission");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const config = toEngineConfig({
  project: { name: "Acme Coffee", domain: "acme.com" },
  positives: ["espresso"],
  negatives: ["jobs"],
});

function candidate(
  keyword: string,
  overrides: Partial<UniverseCandidate> = {},
): UniverseCandidate {
  return { keyword, source: "gsc", ...overrides };
}

function admit(
  candidates: UniverseCandidate[],
  existingNotes = new Map<string, string | null>(),
) {
  return admitCandidates({ candidates, config, existingNotes });
}

describe("imputeVolume", () => {
  it("lets measured impressions beat a vendor zero", () => {
    expect(imputeVolume(null, 400)).toBe(400);
    expect(imputeVolume(0, 400)).toBe(400);
  });

  it("keeps the vendor's number when it is the bigger one", () => {
    expect(imputeVolume(900, 40)).toBe(900);
  });

  it("leaves a row nobody measured alone", () => {
    expect(imputeVolume(null, null)).toBeNull();
  });
});

describe("admitCandidates", () => {
  it("counts a gate reject and writes nothing for it", () => {
    const result = admit([
      candidate("best espresso machine"),
      candidate("milk frother reviews"),
      candidate("espresso barista jobs"),
    ]);

    // The run's honesty depends on this pair reconciling: rejects are counted
    // here and stored nowhere.
    expect(result.seen).toBe(3);
    expect(result.rows.map((row) => row.keyword)).toEqual([
      "best espresso machine",
    ]);
  });

  it("scores a Search Console row off proven demand, not the vendor's zero", () => {
    const [row] = admit([
      candidate("espresso descaling", {
        searchVolume: null,
        impressions28: 400,
      }),
    ]).rows;

    expect(row.score).toBe(score(400, null, null));
    // The column still says what the vendor priced — nothing — so the table's
    // "—" stays honest and the planner does its own max() from the notes.
    expect(row.searchVolume).toBeNull();
    expect(readImpressions28(row.notesJson)).toBe(400);
  });

  it("stores no impressions key for a source that never measured any", () => {
    const [row] = admit([
      candidate("espresso grinder", {
        source: "autocomplete",
        searchVolume: 480,
        keywordDifficulty: 30,
        intent: "commercial",
      }),
    ]).rows;

    expect(row.score).toBe(score(480, 30, "commercial"));
    expect(row.notesJson).toBeNull();
  });

  it("classifies with the engine's own vocabulary", () => {
    const [row] = admit([candidate("espresso machine vs delonghi")]).rows;

    expect(row.category).toBe("Compare");
    expect(row.format).toBe("comparison");
  });

  it("normalizes the keyword the unique index is keyed on", () => {
    const [row] = admit([candidate("  Espresso   Machine ")]).rows;

    expect(row.keyword).toBe("espresso machine");
  });

  it("keeps one row when two sources find the same keyword in one run", () => {
    const result = admit([
      candidate("espresso descaling", { source: "gsc" }),
      candidate("Espresso Descaling", { source: "autocomplete" }),
    ]);

    // Both were seen; letting both through would make the batch's own upserts
    // race each other for the same conflict target.
    expect(result.seen).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe("gsc");
  });

  it("does not count a parser's empty string as a candidate", () => {
    expect(admit([candidate("   ")]).seen).toBe(0);
  });

  it("merges into the notes an earlier source left on the row", () => {
    const [row] = admit(
      [
        candidate("espresso descaling", {
          source: "gap",
          notes: { via: "b.example" },
        }),
      ],
      new Map([["espresso descaling", '{"impr28":250}']]),
    ).rows;

    expect(JSON.parse(row.notesJson ?? "{}")).toEqual({
      impr28: 250,
      via: "b.example",
    });
  });
});

describe("admitAndStore", () => {
  beforeEach(() => {
    mocks.gate.loadEngineConfig.mockResolvedValue(config);
    mocks.repo.getBacklogKeywordNotes.mockResolvedValue([]);
  });

  it("stores only what passed and reports both counts", async () => {
    const result = await admitAndStore({
      projectId: PROJECT_ID,
      candidates: [
        candidate("best espresso machine"),
        candidate("milk frother reviews"),
      ],
    });

    expect(result).toEqual({ seen: 2, kept: 1 });
    const [projectId, rows] = mocks.repo.upsertBacklogRows.mock.calls[0];
    expect(projectId).toBe(PROJECT_ID);
    expect(rows).toHaveLength(1);
  });

  it("admits nothing when the project has no gate to write through", async () => {
    mocks.gate.loadEngineConfig.mockResolvedValue(null);

    const result = await admitAndStore({
      projectId: PROJECT_ID,
      candidates: [candidate("best espresso machine")],
    });

    // An open gate would be the one failure mode this feature cannot have.
    expect(result).toEqual({ seen: 1, kept: 0 });
    expect(mocks.repo.upsertBacklogRows).not.toHaveBeenCalled();
  });
});
