import { describe, expect, it } from "vitest";
import {
  configFromFields,
  EMPTY_PUBLISH_FIELDS,
  publishFieldsComplete,
} from "@/client/features/rankloop-articles/publishConnection.logic";

const settings = { defaultPostStatus: "draft" as const, linkInjection: true };

describe("configFromFields", () => {
  it("omits an untouched secret so an unrelated edit can't wipe a working credential", () => {
    const config = configFromFields(
      "wordpress",
      {
        ...EMPTY_PUBLISH_FIELDS,
        baseUrl: "https://example.com",
        username: "editor",
      },
      settings,
    );
    expect(config).toEqual({
      adapter: "wordpress",
      defaultPostStatus: "draft",
      linkInjection: true,
      baseUrl: "https://example.com",
      username: "editor",
      applicationPassword: undefined,
    });
  });

  it("carries a typed secret through and trims what the user pasted", () => {
    const config = configFromFields(
      "webhook",
      {
        ...EMPTY_PUBLISH_FIELDS,
        url: "  https://example.com/hooks/rankloop  ",
        secret: " s3cret ",
        siteUrl: "https://example.com",
      },
      settings,
    );
    expect(config).toEqual({
      adapter: "webhook",
      defaultPostStatus: "draft",
      linkInjection: true,
      url: "https://example.com/hooks/rankloop",
      secret: "s3cret",
      siteUrl: "https://example.com",
    });
  });

  it("keeps GitHub's commit mode, because a direct commit is a deploy nobody reviewed", () => {
    const config = configFromFields(
      "github",
      {
        ...EMPTY_PUBLISH_FIELDS,
        owner: "acme",
        repo: "site",
        token: "github_pat_x",
        siteUrl: "https://acme.com",
        commitMode: "direct",
      },
      settings,
    );
    expect(config).toMatchObject({
      adapter: "github",
      commitMode: "direct",
      baseBranch: "main",
      contentDir: "content",
    });
  });

  it("sends the public directory a repo actually serves from, not the default it was assumed to have", () => {
    const config = configFromFields(
      "github",
      {
        ...EMPTY_PUBLISH_FIELDS,
        owner: "acme",
        repo: "site",
        token: "github_pat_x",
        siteUrl: "https://acme.com",
        publicDir: " static ",
      },
      settings,
    );
    expect(config).toMatchObject({ adapter: "github", publicDir: "static" });
  });
});

describe("publishFieldsComplete", () => {
  it("accepts a stored secret in place of a retyped one", () => {
    const fields = {
      ...EMPTY_PUBLISH_FIELDS,
      baseUrl: "https://example.com",
      username: "editor",
    };
    expect(publishFieldsComplete("wordpress", fields, false)).toBe(false);
    expect(publishFieldsComplete("wordpress", fields, true)).toBe(true);
  });

  it("asks a webhook for the site root too, since it computes its own URLs", () => {
    const fields = {
      ...EMPTY_PUBLISH_FIELDS,
      url: "https://example.com/hooks/rankloop",
      secret: "s3cret",
    };
    expect(publishFieldsComplete("webhook", fields, false)).toBe(false);
    expect(
      publishFieldsComplete(
        "webhook",
        { ...fields, siteUrl: "https://example.com" },
        false,
      ),
    ).toBe(true);
  });
});
