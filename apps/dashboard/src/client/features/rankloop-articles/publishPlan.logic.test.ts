import { describe, expect, it } from "vitest";
import {
  linksInjectedLabel,
  publishedPath,
  publishLinkCaveat,
  publishPlanSentence,
} from "./publishPlan.logic";

describe("publishPlanSentence", () => {
  it("states the draft, the hub and the link count — the spec's own example", () => {
    expect(
      publishPlanSentence({
        action: "creates-draft",
        target: "yoursite.com",
        hub: { name: "Comparisons", exists: true },
        linkTargetCount: 2,
      }),
    ).toBe(
      "Creates a draft post on yoursite.com, adds it to the Comparisons hub, and links to it from 2 existing posts.",
    );
  });

  it("says the hub is created first when it does not exist yet", () => {
    expect(
      publishPlanSentence({
        action: "creates-draft",
        target: "yoursite.com",
        hub: { name: "Comparisons", exists: false },
        linkTargetCount: 1,
      }),
    ).toBe(
      "Creates a draft post on yoursite.com, creates the Comparisons hub first and adds it there, and links to it from 1 existing post.",
    );
  });

  it("drops the draft promise when the target is set to publish live", () => {
    expect(
      publishPlanSentence({
        action: "publishes",
        target: "yoursite.com",
        hub: null,
        linkTargetCount: 0,
      }),
    ).toBe("Publishes a post on yoursite.com.");
  });

  it("names the pull request rather than promising a live post", () => {
    expect(
      publishPlanSentence({
        action: "opens-pull-request",
        target: "acme/site",
        hub: { name: "Guides", exists: true },
        linkTargetCount: 3,
      }),
    ).toBe(
      "Opens a pull request on acme/site, adds it to the Guides hub, and links to it from 3 existing posts.",
    );
  });

  it("says commit when the same adapter is set to commit directly", () => {
    expect(
      publishPlanSentence({
        action: "commits",
        target: "acme/site",
        hub: { name: "Guides", exists: true },
        linkTargetCount: 0,
      }),
    ).toBe("Commits the post to acme/site and adds it to the Guides hub.");
  });

  it("says the webhook is sent, because rankloop never touches that site", () => {
    expect(
      publishPlanSentence({
        action: "sends-envelope",
        target: "hooks.example.com",
        hub: { name: "Comparisons", exists: true },
        linkTargetCount: 0,
      }),
    ).toBe(
      "Sends the post to hooks.example.com and adds it to the Comparisons hub.",
    );
  });
});

describe("publishLinkCaveat", () => {
  it("says the hub is the only way in when injection is switched off", () => {
    expect(
      publishLinkCaveat({ linkInjection: false, linkTargetCount: 4 }),
    ).toBe(
      "Link injection is off, so the hub is the only page that will point at it.",
    );
  });

  it("says the same thing when the manifest has no neighbours to link from", () => {
    expect(publishLinkCaveat({ linkInjection: true, linkTargetCount: 0 })).toBe(
      "No related pages in the manifest yet, so the hub is the only page that will point at it.",
    );
  });

  it("stays quiet when the sentence already carried the link count", () => {
    expect(
      publishLinkCaveat({ linkInjection: true, linkTargetCount: 2 }),
    ).toBeNull();
  });
});

describe("linksInjectedLabel", () => {
  it("renders the em dash rather than claiming zero posts", () => {
    expect(linksInjectedLabel(0)).toBe("—");
  });

  it("pluralises by hand", () => {
    expect(linksInjectedLabel(1)).toBe("1 post");
    expect(linksInjectedLabel(3)).toBe("3 posts");
  });
});

describe("publishedPath", () => {
  it("shows the path a reader would recognise", () => {
    expect(publishedPath("https://yoursite.com/blog/best-crm")).toBe(
      "/blog/best-crm",
    );
  });

  it("falls back to the raw value instead of dropping an unparseable URL", () => {
    expect(publishedPath("not-a-url")).toBe("not-a-url");
  });
});
