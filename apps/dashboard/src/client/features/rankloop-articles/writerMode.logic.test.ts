import { describe, expect, it } from "vitest";
import { writeActionState } from "@/client/features/rankloop-articles/writerMode.logic";

describe("writeActionState", () => {
  it("replaces the Write button with the waiting state in agent mode", () => {
    expect(
      writeActionState({
        writerMode: "agent",
        article: undefined,
        providerConfigured: true,
      }),
    ).toBe("waiting-agent");
  });

  it("never pitches an OpenRouter key in agent mode — no key of ours writes there", () => {
    expect(
      writeActionState({
        writerMode: "agent",
        article: undefined,
        providerConfigured: false,
      }),
    ).toBe("waiting-agent");
  });

  it("keeps the link to a draft that already exists, whichever mode is set now", () => {
    expect(
      writeActionState({
        writerMode: "agent",
        article: { status: "writing" },
        providerConfigured: true,
      }),
    ).toBe("open-draft");
    expect(
      writeActionState({
        writerMode: "api",
        article: { status: "published" },
        providerConfigured: false,
      }),
    ).toBe("open-draft");
  });

  it("offers the key pitch before the spend button in api mode", () => {
    expect(
      writeActionState({
        writerMode: "api",
        article: undefined,
        providerConfigured: false,
      }),
    ).toBe("add-key");
    expect(
      writeActionState({
        writerMode: "api",
        article: undefined,
        providerConfigured: true,
      }),
    ).toBe("write");
  });
});
