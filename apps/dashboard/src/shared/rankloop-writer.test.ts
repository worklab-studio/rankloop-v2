import { describe, expect, it } from "vitest";
import { landingStatus } from "./rankloop-writer";

describe("landingStatus", () => {
  it("skips review only on the dial that says the human already decided", () => {
    expect(landingStatus("titles")).toBe("approved");
    expect(landingStatus("drafts")).toBe("review");
    expect(landingStatus("autopilot")).toBe("review");
  });
});
