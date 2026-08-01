import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getMeasuredReceipts: vi.fn(),
    getRecentGateVerdicts: vi.fn(),
    getFailedConnection: vi.fn(),
    getState: vi.fn(),
    saveState: vi.fn(),
  },
  settings: {
    getSettings: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/routines/repositories/AutopilotRepository",
  () => ({ AutopilotRepository: mocks.repo }),
);
vi.mock(
  "@/server/features/rankloop/writing/repositories/WriterSettingsRepository",
  () => ({ WriterSettingsRepository: mocks.settings }),
);

const NOW = new Date("2026-08-01T07:00:00.000Z");

/** A measured receipt row as the repository returns it: JSON columns, unparsed. */
function receiptRow(actionType: string, from: number, to: number) {
  return {
    actionType,
    windowEnd: "2026-04-01",
    baselineJson: JSON.stringify({
      impressions: 1000,
      clicks: 30,
      ctr: 0.03,
      weightedPosition: from,
      siteImpressions: 50000,
      siteClicks: 900,
      window: { start: "2026-01-01", end: "2026-01-28" },
    }),
    resultJson: JSON.stringify({
      impressions: 1400,
      clicks: 70,
      ctr: 0.05,
      weightedPosition: to,
      siteImpressions: 51000,
      siteClicks: 910,
      window: { start: "2026-03-04", end: "2026-03-31" },
      clicksDelta: 40,
      siteClicksDeltaRatio: 0.01,
      adjustedClicksDelta: 39.7,
    }),
  };
}

/** A graded draft, as the article row stores it. */
function verdictRow(at: string, passed: boolean) {
  return {
    at,
    lawReportJson: JSON.stringify({
      passed,
      checkedAt: at,
      laws: [{ law: "faq", passed, threshold: null, excerpt: null }],
      failure: passed ? null : { reason: "laws_unmet", detail: "1 law unmet." },
    }),
  };
}

/** A draft that died before any law saw it: no checklist, and a reason that
 *  belongs to the writer rather than the gate. */
function writerFailureRow(at: string, reason = "truncated") {
  return {
    at,
    lawReportJson: JSON.stringify({
      passed: false,
      checkedAt: at,
      laws: [],
      failure: { reason, detail: "The model stopped at the token ceiling." },
    }),
  };
}

/** The stored kill switch, with the columns a test does not care about
 *  filled in — a project that has been reconciled and is running. */
function stateRow(
  overrides: Partial<{
    consecutiveGateFailures: number;
    consecutiveWriterFailures: number;
    pausedAt: string | null;
    pausedReason: string | null;
    updatedAt: string;
  }> = {},
) {
  return {
    id: "state_1",
    projectId: "project_1",
    consecutiveGateFailures: 0,
    consecutiveWriterFailures: 0,
    pausedAt: null,
    pausedReason: null,
    updatedAt: "2026-07-29T07:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.repo.getMeasuredReceipts.mockResolvedValue([]);
  mocks.repo.getRecentGateVerdicts.mockResolvedValue([]);
  mocks.repo.getFailedConnection.mockResolvedValue(null);
  mocks.repo.getState.mockResolvedValue(null);
  mocks.repo.saveState.mockResolvedValue(undefined);
  mocks.settings.getSettings.mockResolvedValue({ trustDial: "autopilot" });
});

async function statusFor() {
  const { AutopilotService } = await import("./AutopilotService");
  return AutopilotService.getStatus({ projectId: "project_1", now: NOW });
}

function typeNamed(
  status: Awaited<ReturnType<typeof statusFor>>,
  actionType: string,
) {
  const match = status.types.find((type) => type.actionType === actionType);
  if (!match) throw new Error(`no status for ${actionType}`);
  return match;
}

describe("AutopilotService.getStatus", () => {
  it("earns autopilot only for the type whose receipts proved it", async () => {
    mocks.repo.getMeasuredReceipts.mockResolvedValue([
      // retitle: five settled wins.
      ...Array.from({ length: 5 }, () => receiptRow("retitle", 10, 7)),
      // write_new: two, which is not a cohort.
      receiptRow("write_new", 20, 15),
      receiptRow("write_new", 20, 15),
    ]);

    const status = await statusFor();

    expect(typeNamed(status, "retitle").behavior).toBe("autopilot");
    expect(typeNamed(status, "retitle").fallbackReason).toBeNull();
    expect(typeNamed(status, "write_new").behavior).toBe("drafts");
    expect(typeNamed(status, "write_new").fallbackReason).toBe(
      "needs 5 measured results, has 2",
    );
  });

  it("never hands merge or prune to the machine, even on a perfect record", async () => {
    mocks.repo.getMeasuredReceipts.mockResolvedValue(
      Array.from({ length: 20 }, () => receiptRow("merge", 30, 2)),
    );

    const status = await statusFor();

    expect(typeNamed(status, "merge").behavior).toBe("drafts");
    expect(typeNamed(status, "prune").behavior).toBe("drafts");
    expect(typeNamed(status, "merge").fallbackReason).toBe(
      "never unattended — this action removes a page that exists",
    );
  });

  it("leaves a drafts dial exactly where it is, eligible or not", async () => {
    mocks.settings.getSettings.mockResolvedValue({ trustDial: "drafts" });
    mocks.repo.getMeasuredReceipts.mockResolvedValue(
      Array.from({ length: 5 }, () => receiptRow("retitle", 10, 7)),
    );

    const status = await statusFor();

    expect(typeNamed(status, "retitle").eligible).toBe(true);
    expect(typeNamed(status, "retitle").behavior).toBe("drafts");
    expect(typeNamed(status, "retitle").fallbackReason).toBeNull();
  });

  it("runs on the shipped default when the project has never saved settings", async () => {
    mocks.settings.getSettings.mockResolvedValue(null);

    expect((await statusFor()).trustDial).toBe("titles");
  });

  // -------------------------------------------------------------------------
  // Kill switches
  // -------------------------------------------------------------------------

  it("pauses every type after three consecutive failed gates", async () => {
    mocks.repo.getMeasuredReceipts.mockResolvedValue(
      Array.from({ length: 5 }, () => receiptRow("retitle", 10, 7)),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      verdictRow("2026-08-01T06:00:00.000Z", false),
      verdictRow("2026-07-31T06:00:00.000Z", false),
      verdictRow("2026-07-30T06:00:00.000Z", false),
    ]);

    const status = await statusFor();

    expect(status.pause?.reason).toBe(
      "autopilot paused — 3 drafts in a row failed the gate",
    );
    expect(typeNamed(status, "retitle").behavior).toBe("drafts");
  });

  it("pauses on three drafts that never reached a law, in its own words", async () => {
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      writerFailureRow("2026-08-01T06:00:00.000Z"),
      writerFailureRow("2026-07-31T06:00:00.000Z", "provider_error"),
      writerFailureRow("2026-07-30T06:00:00.000Z"),
    ]);

    const status = await statusFor();

    // Not "failed the gate": there is no law report to open, and sending the
    // operator to one would be the wrong first move.
    expect(status.pause?.reason).toBe(
      "autopilot paused — 3 drafts in a row never reached the gate",
    );
    expect(status.consecutiveGateFailures).toBe(0);
  });

  it("does not blame the gate for a provider outage", async () => {
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      {
        at: "2026-08-01T06:00:00.000Z",
        lawReportJson: JSON.stringify({
          passed: false,
          checkedAt: "2026-08-01T06:00:00.000Z",
          laws: [{ law: "faq", passed: false, threshold: null, excerpt: null }],
          failure: { reason: "provider_error", detail: "502 from provider." },
        }),
      },
      verdictRow("2026-07-31T06:00:00.000Z", false),
      verdictRow("2026-07-30T06:00:00.000Z", false),
    ]);

    expect((await statusFor()).pause).toBeNull();
  });

  it("pauses on a rejected credential and reports the adapter separately", async () => {
    mocks.repo.getFailedConnection.mockResolvedValue({
      adapter: "wordpress",
      lastCheckedAt: "2026-07-31T22:10:00.000Z",
    });

    const status = await statusFor();

    expect(status.pause).toEqual({
      reason: "autopilot paused — wordpress rejected our credentials",
      since: "2026-07-31T22:10:00.000Z",
    });
    expect(status.adapterError?.adapter).toBe("wordpress");
  });

  it("treats a receipt whose stored JSON no longer parses as no evidence, not as zero", async () => {
    mocks.repo.getMeasuredReceipts.mockResolvedValue([
      ...Array.from({ length: 4 }, () => receiptRow("retitle", 10, 7)),
      {
        actionType: "retitle",
        windowEnd: "2026-04-01",
        baselineJson: "{oops",
        resultJson: null,
      },
    ]);

    expect(typeNamed(await statusFor(), "retitle").reason).toBe(
      "needs 5 measured results, has 4",
    );
  });
});

describe("AutopilotService.reconcile", () => {
  async function reconcile() {
    const { AutopilotService } = await import("./AutopilotService");
    return AutopilotService.reconcile({ projectId: "project_1", now: NOW });
  }

  it("trips at exactly three, and stores the pause with the count", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ consecutiveGateFailures: 2 }),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      verdictRow("2026-08-01T06:00:00.000Z", false),
    ]);

    const pause = await reconcile();

    expect(pause?.reason).toBe(
      "autopilot paused — 3 drafts in a row failed the gate",
    );
    expect(mocks.repo.saveState).toHaveBeenCalledWith({
      projectId: "project_1",
      consecutiveGateFailures: 3,
      // The gate rejected this draft, so it reached one: the writer's own
      // streak is broken by exactly the verdict that trips the gate's.
      consecutiveWriterFailures: 0,
      pausedAt: "2026-08-01T06:00:00.000Z",
      pausedReason: "autopilot paused — 3 drafts in a row failed the gate",
      updatedAt: NOW.toISOString(),
    });
  });

  it("counts a truncated draft against the writer, never against the gate", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ consecutiveGateFailures: 2, consecutiveWriterFailures: 2 }),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      writerFailureRow("2026-08-01T06:00:00.000Z"),
    ]);

    const pause = await reconcile();

    expect(pause?.reason).toBe(
      "autopilot paused — 3 drafts in a row never reached the gate",
    );
    expect(mocks.repo.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        // The gate's stored 2 stands: nothing about this verdict was a law's
        // doing, and zeroing it would forgive two drafts the laws did reject.
        consecutiveGateFailures: 2,
        consecutiveWriterFailures: 3,
      }),
    );
  });

  it("does not trip on two, and keeps counting", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ consecutiveGateFailures: 1 }),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      verdictRow("2026-08-01T06:00:00.000Z", false),
    ]);

    expect(await reconcile()).toBeNull();
    expect(mocks.repo.saveState).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveGateFailures: 2, pausedAt: null }),
    );
  });

  it("resets the count on a passing gate", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ consecutiveGateFailures: 2 }),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      verdictRow("2026-08-01T06:00:00.000Z", true),
      verdictRow("2026-08-01T05:00:00.000Z", false),
    ]);

    expect(await reconcile()).toBeNull();
    expect(mocks.repo.saveState).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveGateFailures: 0 }),
    );
  });

  it("pauses immediately on a rejected credential, before any counting", async () => {
    mocks.repo.getFailedConnection.mockResolvedValue({
      adapter: "wordpress",
      lastCheckedAt: "2026-08-01T06:12:00.000Z",
    });
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([
      verdictRow("2026-08-01T06:00:00.000Z", true),
    ]);

    const pause = await reconcile();

    expect(pause).toEqual({
      reason: "autopilot paused — wordpress rejected our credentials",
      since: "2026-08-01T06:12:00.000Z",
    });
    expect(mocks.repo.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        pausedReason: "autopilot paused — wordpress rejected our credentials",
      }),
    );
  });

  it("leaves a stored pause exactly as it is — only a human clears it", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({
        consecutiveGateFailures: 3,
        pausedAt: "2026-07-30T09:00:00.000Z",
        pausedReason: "autopilot paused — 3 drafts in a row failed the gate",
      }),
    );

    const pause = await reconcile();

    expect(pause?.since).toBe("2026-07-30T09:00:00.000Z");
    expect(mocks.repo.saveState).not.toHaveBeenCalled();
    // The verdict window is never even read: the streak that caused this is
    // history, and re-folding it could only re-date the pause.
    expect(mocks.repo.getRecentGateVerdicts).not.toHaveBeenCalled();
  });

  it("writes nothing when no verdict has landed since the watermark", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ consecutiveGateFailures: 2 }),
    );

    expect(await reconcile()).toBeNull();
    expect(mocks.repo.saveState).not.toHaveBeenCalled();
  });

  it("folds only the verdicts newer than the stored watermark", async () => {
    mocks.repo.getState.mockResolvedValue(
      stateRow({ updatedAt: "2026-07-31T12:00:00.000Z" }),
    );

    await reconcile();

    expect(mocks.repo.getRecentGateVerdicts).toHaveBeenCalledWith(
      "project_1",
      "2026-07-31T12:00:00.000Z",
    );
  });
});

describe("AutopilotService.resume", () => {
  it("clears the pause and the count, and moves the watermark to now", async () => {
    const { AutopilotService } = await import("./AutopilotService");

    await AutopilotService.resume({ projectId: "project_1", now: NOW });

    expect(mocks.repo.saveState).toHaveBeenCalledWith({
      projectId: "project_1",
      consecutiveGateFailures: 0,
      consecutiveWriterFailures: 0,
      pausedAt: null,
      pausedReason: null,
      updatedAt: NOW.toISOString(),
    });
  });

  it("leaves the three failures that tripped it behind the watermark", async () => {
    const { AutopilotService } = await import("./AutopilotService");
    await AutopilotService.resume({ projectId: "project_1", now: NOW });

    // The next run reads the row it just wrote: no pause, no count, and a
    // window that starts after every draft that caused the last one.
    mocks.repo.getState.mockResolvedValue(
      stateRow({ updatedAt: NOW.toISOString() }),
    );
    mocks.repo.getRecentGateVerdicts.mockResolvedValue([]);

    expect((await statusFor()).pause).toBeNull();
  });
});

describe("AutopilotService.getActionBehavior", () => {
  it("answers for one type", async () => {
    mocks.repo.getMeasuredReceipts.mockResolvedValue(
      Array.from({ length: 5 }, () => receiptRow("retitle", 10, 7)),
    );
    const { AutopilotService } = await import("./AutopilotService");

    await expect(
      AutopilotService.getActionBehavior({
        projectId: "project_1",
        actionType: "retitle",
        now: NOW,
      }),
    ).resolves.toEqual({ behavior: "autopilot", fallbackReason: null });
  });

  it("falls back for an action type the proposals column has never heard of", async () => {
    const { AutopilotService } = await import("./AutopilotService");

    await expect(
      AutopilotService.getActionBehavior({
        projectId: "project_1",
        actionType: "transmogrify",
        now: NOW,
      }),
    ).resolves.toEqual({
      behavior: "drafts",
      fallbackReason: "no receipts exist for transmogrify",
    });
  });
});
