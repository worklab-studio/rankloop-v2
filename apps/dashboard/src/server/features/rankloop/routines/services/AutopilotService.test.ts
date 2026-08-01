import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: {
    getMeasuredReceipts: vi.fn(),
    getRecentGateVerdicts: vi.fn(),
    getFailedConnection: vi.fn(),
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

beforeEach(() => {
  mocks.repo.getMeasuredReceipts.mockResolvedValue([]);
  mocks.repo.getRecentGateVerdicts.mockResolvedValue([]);
  mocks.repo.getFailedConnection.mockResolvedValue(null);
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
