// This is the one place rankloop makes a claim about somebody else's page.
// Every case below is one where a plausible implementation reports a link
// that is not there, or overrules a human.

import { describe, expect, it } from "vitest";
import { findLinksTo, statusAfterVerify, verdictFor } from "./linkVerify.logic";

const DOMAIN = "rankloop.dev";

describe("findLinksTo()", () => {
  it("finds a plain link", () => {
    const links = findLinksTo(
      '<a href="https://rankloop.dev">Rankloop</a>',
      DOMAIN,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.anchor).toBe("Rankloop");
  });

  it("matches www and bare interchangeably", () => {
    expect(findLinksTo('<a href="https://www.rankloop.dev/">x</a>', DOMAIN)).toHaveLength(1);
    expect(findLinksTo('<a href="https://rankloop.dev/">x</a>', "www.rankloop.dev")).toHaveLength(1);
  });

  it("does not match a domain that merely contains ours", () => {
    // Substring matching is the obvious implementation and it reports
    // not-rankloop.dev as a link to rankloop.dev.
    expect(findLinksTo('<a href="https://not-rankloop.dev">x</a>', DOMAIN)).toHaveLength(0);
    expect(findLinksTo('<a href="https://rankloop.dev.evil.com">x</a>', DOMAIN)).toHaveLength(0);
  });

  it("does not match our domain in a query string", () => {
    // A page that links to a competitor with ?ref=rankloop.dev is not
    // linking to us, and counting it would report a win that never happened.
    expect(
      findLinksTo('<a href="https://other.com/go?ref=rankloop.dev">x</a>', DOMAIN),
    ).toHaveLength(0);
  });

  it("records nofollow rather than discarding or ignoring it", () => {
    // Still a listing, still worth having, materially different from a
    // followed link. Filtering it out loses a real result; counting it as
    // equal overstates one.
    const [link] = findLinksTo(
      '<a href="https://rankloop.dev" rel="nofollow noopener">Rankloop</a>',
      DOMAIN,
    );
    expect(link?.nofollow).toBe(true);
  });

  it("treats sponsored and ugc as nofollow", () => {
    expect(
      findLinksTo('<a rel="sponsored" href="https://rankloop.dev">x</a>', DOMAIN)[0]?.nofollow,
    ).toBe(true);
    expect(
      findLinksTo('<a rel="ugc" href="https://rankloop.dev">x</a>', DOMAIN)[0]?.nofollow,
    ).toBe(true);
  });

  it("marks an ordinary link as followed", () => {
    expect(
      findLinksTo('<a rel="noopener" href="https://rankloop.dev">x</a>', DOMAIN)[0]?.nofollow,
    ).toBe(false);
  });

  it("handles single quotes, no quotes, and protocol-relative hrefs", () => {
    expect(findLinksTo("<a href='https://rankloop.dev'>x</a>", DOMAIN)).toHaveLength(1);
    expect(findLinksTo("<a href=https://rankloop.dev>x</a>", DOMAIN)).toHaveLength(1);
    expect(findLinksTo('<a href="//rankloop.dev/">x</a>', DOMAIN)).toHaveLength(1);
  });

  it("reads anchor text out of nested markup", () => {
    const [link] = findLinksTo(
      '<a href="https://rankloop.dev"><span>Rank</span><b>loop</b> SEO</a>',
      DOMAIN,
    );
    expect(link?.anchor).toBe("Rank loop SEO");
  });

  it("ignores relative links", () => {
    expect(findLinksTo('<a href="/rankloop.dev">x</a>', DOMAIN)).toHaveLength(0);
  });

  it("finds several listings on one page", () => {
    const html = `
      <a href="https://rankloop.dev">Rankloop</a>
      <a href="https://rankloop.dev/pricing">Pricing</a>`;
    expect(findLinksTo(html, DOMAIN)).toHaveLength(2);
  });
});

describe("verdictFor()", () => {
  it("reports live when the link is there", () => {
    const v = verdictFor({
      status: 200,
      html: '<a href="https://rankloop.dev">x</a>',
      domain: DOMAIN,
    });
    expect(v.state).toBe("live");
  });

  it("separates 'we looked and it is not there' from 'we could not look'", () => {
    // Conflating them makes the board report absences it never observed.
    expect(verdictFor({ status: 200, html: "<p>nothing</p>", domain: DOMAIN }).state).toBe(
      "not_found",
    );
    expect(verdictFor({ status: null, html: null, domain: DOMAIN }).state).toBe(
      "unreachable",
    );
    expect(verdictFor({ status: 403, html: "", domain: DOMAIN }).state).toBe(
      "unreachable",
    );
  });

  it("never returns a rejected verdict", () => {
    // A missing link may be a moderation queue or an editor on holiday.
    // Calling that "rejected" is a guess presented as a fact.
    const states = [
      verdictFor({ status: 200, html: "<p>x</p>", domain: DOMAIN }).state,
      verdictFor({ status: 404, html: "", domain: DOMAIN }).state,
    ];
    expect(states).not.toContain("rejected");
  });
});

describe("statusAfterVerify()", () => {
  const live = verdictFor({
    status: 200,
    html: '<a href="https://rankloop.dev">x</a>',
    domain: DOMAIN,
  });

  it("promotes a row that was waiting on an outcome", () => {
    expect(statusAfterVerify({ current: "sent", verdict: live })?.status).toBe("linked");
    expect(statusAfterVerify({ current: "replied", verdict: live })?.status).toBe("linked");
  });

  it("promotes a row nobody has touched — a listing can appear unbidden", () => {
    expect(statusAfterVerify({ current: "to_contact", verdict: live })?.status).toBe(
      "linked",
    );
  });

  it("does not overrule a human who marked it declined", () => {
    // They may have withdrawn the submission and be looking at somebody
    // else's link on the same page. Their record wins.
    expect(statusAfterVerify({ current: "declined", verdict: live })).toBeNull();
  });

  it("does nothing for a row already recorded as linked", () => {
    expect(statusAfterVerify({ current: "linked", verdict: live })).toBeNull();
  });

  it("changes nothing when the link is absent or the page unreachable", () => {
    for (const verdict of [
      verdictFor({ status: 200, html: "<p>x</p>", domain: DOMAIN }),
      verdictFor({ status: null, html: null, domain: DOMAIN }),
    ]) {
      expect(statusAfterVerify({ current: "sent", verdict })).toBeNull();
    }
  });
});
