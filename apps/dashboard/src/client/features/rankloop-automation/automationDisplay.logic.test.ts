import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_PUBLISH_CAP,
  AUTOPILOT_WRITE_CAP,
} from "@/shared/rankloop-autopilot";
import {
  behaviorDotClass,
  digestWebhookUrlError,
  dispatcherCopy,
  nextRunCopy,
  pauseCopy,
  trustDialCopy,
  unattendedCapsCopy,
} from "./automationDisplay.logic";

const NOW = Date.parse("2026-08-01T12:00:00Z");

describe("dispatcherCopy", () => {
  it("names cron as the driver and the alarm as its backstop", () => {
    const copy = dispatcherCopy({ mechanism: "cron", nextRunAt: null });
    expect(copy.label).toBe("Cloudflare cron");
    expect(copy.detail).toContain("backstop");
  });

  it("says outright that cron never fires here when the alarm is driving", () => {
    const copy = dispatcherCopy({ mechanism: "alarm", nextRunAt: null });
    expect(copy.label).toBe("Durable Object alarm");
    expect(copy.detail).toContain("never fire outside Cloudflare");
    // Neither reading is the bad one — the surface must not imply the
    // self-host install is running a lesser version of the routine.
    expect(copy.detail).toContain("same code path");
  });
});

describe("nextRunCopy", () => {
  it("counts down in minutes, then hours", () => {
    expect(nextRunCopy("2026-08-01T12:12:00Z", NOW)).toBe("next run in 12m");
    expect(nextRunCopy("2026-08-01T15:00:00Z", NOW)).toBe("next run in 3h");
  });

  it("shows how late a lost alarm is instead of rounding it to due now", () => {
    expect(nextRunCopy("2026-08-01T11:59:30Z", NOW)).toBe("next run due now");
    expect(nextRunCopy("2026-08-01T11:20:00Z", NOW)).toBe(
      "next run 40m overdue",
    );
  });

  it("admits an unarmed schedule rather than inventing a time", () => {
    expect(nextRunCopy(null, NOW)).toBe("no run scheduled yet");
    expect(nextRunCopy("not a date", NOW)).toBe("no run scheduled yet");
  });

  it("reads a bare SQLite timestamp as UTC, like every other card does", () => {
    expect(nextRunCopy("2026-08-01 12:30:00", NOW)).toBe("next run in 30m");
  });
});

describe("trustDialCopy", () => {
  it("says where each dial stops", () => {
    expect(trustDialCopy("titles")).toContain("you write the post");
    expect(trustDialCopy("drafts")).toContain("without a yes");
  });

  it("names autopilot's fallback so the setting can't read as a promise", () => {
    expect(trustDialCopy("autopilot")).toContain("falls back to Drafts");
  });
});

describe("unattendedCapsCopy", () => {
  it("prints the caps the block obeys, not a second set typed by hand", () => {
    const copy = unattendedCapsCopy();
    expect(copy).toContain(`writes ${AUTOPILOT_WRITE_CAP}`);
    expect(copy).toContain(`publishes ${AUTOPILOT_PUBLISH_CAP}`);
  });

  it("names the quota for approvals rather than claiming a number of its own", () => {
    expect(unattendedCapsCopy()).toContain("today's quota");
  });
});

describe("behaviorDotClass", () => {
  it("fills the dot only for a type actually running unattended", () => {
    expect(behaviorDotClass({ behavior: "autopilot" })).toBe("bg-success");
  });

  it("leaves an earned type unfilled while the dial or the pause holds it", () => {
    // The row still prints "eligible (…)" from the server; the dot is about
    // what happens today, which is review.
    expect(behaviorDotClass({ behavior: "drafts" })).toBe("bg-base-content/30");
    expect(behaviorDotClass({ behavior: "titles" })).toBe("bg-base-content/30");
  });
});

describe("digestWebhookUrlError", () => {
  it("says nothing about an empty field, which is how the channel is off", () => {
    expect(digestWebhookUrlError("")).toBeNull();
    expect(digestWebhookUrlError("   ")).toBeNull();
  });

  it("accepts an http(s) endpoint", () => {
    expect(
      digestWebhookUrlError("https://example.com/hooks/rankloop"),
    ).toBeNull();
    expect(digestWebhookUrlError("http://localhost:8787/digest")).toBeNull();
  });

  it("rejects a scheme nothing can be POSTed to", () => {
    // Both parse; neither is a place a digest can go.
    expect(digestWebhookUrlError("mailto:me@example.com")).toContain(
      "http:// or https://",
    );
    expect(digestWebhookUrlError("file:///etc/hosts")).toContain(
      "http:// or https://",
    );
  });

  it("asks for the whole address when only a host was typed", () => {
    expect(digestWebhookUrlError("example.com/hooks")).toContain(
      "starting with https://",
    );
  });
});

describe("pauseCopy", () => {
  it("says nothing at all while the switch has not tripped", () => {
    expect(pauseCopy(null, NOW)).toBeNull();
  });

  it("carries the server's own sentence and how long it has been down", () => {
    expect(
      pauseCopy(
        {
          reason: "autopilot paused — 3 drafts in a row failed the gate",
          since: "2026-08-01T09:00:00Z",
        },
        NOW,
      ),
    ).toBe("autopilot paused — 3 drafts in a row failed the gate · 3h ago");
  });

  it("drops the age rather than the reason when the stamp is unreadable", () => {
    expect(pauseCopy({ reason: "autopilot paused", since: "never" }, NOW)).toBe(
      "autopilot paused",
    );
  });
});
