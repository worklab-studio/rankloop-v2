// The probe, with the network injected. The last block replays the real
// shape of productlaunchos.com — apex redirecting to www, an open robots.txt,
// no llms.txt, no edge block, and text present in the raw HTML — because that
// combination is what exposed the two bugs this module is written around.

import { describe, expect, it } from "vitest";
import {
  checkLlmsFiles,
  fetchRobots,
  isLlmsTxtShaped,
  judgeEdgeBlock,
  MIN_HTML_WORDS,
  probeAiAccess,
  resolveOrigin,
  visibleTextWords,
  type FetchImpl,
} from "./aiAccess";

/** What a route answers. `url` models the URL after redirects. */
type Reply = { body?: string; status?: number; url?: string };

function res(url: string, reply: Reply): Response {
  const r = new Response(reply.body ?? "", { status: reply.status ?? 200 });
  // `Response.url` is empty on a constructed response and — the detail that
  // cost a debugging round — is NOT carried across `clone()`. So every route
  // builds a fresh Response and stamps the final URL itself; nothing here may
  // rely on cloning a shared instance.
  Object.defineProperty(r, "url", { value: reply.url ?? url });
  return r;
}

/** A fake network: exact-URL routes, with an optional per-UA override. */
function net(routes: Record<string, Reply | ((ua: string) => Reply)>): FetchImpl {
  // A plain function rather than vi.fn: nothing here asserts on call counts,
  // and the annotated return type gives the parameters their real types
  // instead of `any`.
  return async (url, init) => {
    const ua = init?.headers?.["user-agent"] ?? "";
    const route = routes[url];
    if (route === undefined) return res(url, { body: "not found", status: 404 });
    return res(url, typeof route === "function" ? route(ua) : route);
  };
}

/** Networks that fail, hoisted so they are built once. */
const dnsFailure: FetchImpl = () => Promise.reject(new Error("ENOTFOUND"));
const connectionReset: FetchImpl = () =>
  Promise.reject(new Error("connection reset"));

describe("resolveOrigin()", () => {
  it("follows the apex-to-www redirect and pins the final origin", () => {
    // Without this, robots.txt, llms.txt and sitemap.xml are all fetched from
    // the host that only ever answers 308, and an open site reports as having
    // no robots.txt at all.
    const fetchImpl = net({
      "https://productlaunchos.com/": { body: "<html></html>", url: "https://www.productlaunchos.com/" },
    });
    return expect(
      resolveOrigin("https://productlaunchos.com/", fetchImpl),
    ).resolves.toEqual({
      origin: "https://www.productlaunchos.com",
      redirected: true,
      reachable: true,
    });
  });

  it("keeps the entered origin when nothing redirects", async () => {
    const fetchImpl = net({ "https://x.example/": { body: "<html></html>" } });
    const out = await resolveOrigin("https://x.example/", fetchImpl);
    expect(out).toMatchObject({ origin: "https://x.example", redirected: false });
  });

  it("reports unreachable rather than throwing", async () => {
    const out = await resolveOrigin("https://gone.example/", dnsFailure);
    expect(out).toMatchObject({ reachable: false, origin: "https://gone.example" });
  });
});

describe("fetchRobots()", () => {
  it("reads a 200", async () => {
    const fetchImpl = net({
      "https://x.example/robots.txt": { body: "User-agent: *\nAllow: /" },
    });
    const out = await fetchRobots("https://x.example", fetchImpl);
    expect(out).toMatchObject({ state: "ok" });
  });

  it("calls a 404 absent — the standard's default is everything allowed", async () => {
    const fetchImpl = net({
      "https://x.example/robots.txt": { body: "nope", status: 404 },
    });
    expect(await fetchRobots("https://x.example", fetchImpl)).toMatchObject({
      state: "absent",
      status: 404,
    });
  });

  it("separates a 5xx from a 404, because they mean opposite things", async () => {
    // A crawler that cannot READ robots.txt must back off. A 500 on this one
    // file quietly de-indexes a site, and folding it in with 404 would hide
    // the most urgent finding the card can produce.
    const fetchImpl = net({
      "https://x.example/robots.txt": { body: "boom", status: 503 },
    });
    expect(await fetchRobots("https://x.example", fetchImpl)).toMatchObject({
      state: "unavailable",
      status: 503,
    });
  });

  it("treats a network failure as unavailable, not absent", async () => {
    expect(await fetchRobots("https://x.example", connectionReset)).toMatchObject({
      state: "unavailable",
      status: null,
      detail: "connection reset",
    });
  });
});

describe("llms.txt detection", () => {
  it("accepts a real llms.txt", () => {
    expect(isLlmsTxtShaped("# Example\n\n> A site.\n")).toBe(true);
  });

  it("rejects an SPA shell served with status 200", () => {
    // A single-page app answers 200 with its index for every unknown path.
    // Trusting the status alone reports llms.txt present on sites that have
    // never had one.
    expect(isLlmsTxtShaped("<!doctype html><html><body>…")).toBe(false);
    expect(isLlmsTxtShaped("<html lang=en>")).toBe(false);
  });

  it("finds both files missing on a site that has neither", async () => {
    const fetchImpl = net({});
    const out = await checkLlmsFiles("https://x.example", fetchImpl);
    expect(out).toEqual([
      { path: "/llms.txt", present: false, status: 404 },
      { path: "/llms-full.txt", present: false, status: 404 },
    ]);
  });

  it("finds a real one", async () => {
    const fetchImpl = net({
      "https://x.example/llms.txt": { body: "# Example\n" },
      "https://x.example/llms-full.txt": { body: "nope", status: 404 },
    });
    const out = await checkLlmsFiles("https://x.example", fetchImpl);
    expect(out[0]).toMatchObject({ present: true, status: 200 });
    expect(out[1]).toMatchObject({ present: false });
  });
});

describe("judgeEdgeBlock()", () => {
  const base = { agent: "ClaudeBot", botBytes: 1000, browserBytes: 1000 };

  it("catches a WAF that 403s the bot and serves the browser", () => {
    // The whole reason this check exists: robots.txt can be perfect and the
    // content still unreachable. Every audit tool that only reads the file
    // calls this site open.
    const out = judgeEdgeBlock({ ...base, botStatus: 403, browserStatus: 200, botBytes: 0 });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("403");
  });

  it("catches a JS challenge answering 503", () => {
    expect(
      judgeEdgeBlock({ ...base, botStatus: 503, browserStatus: 200, botBytes: 500 }).blocked,
    ).toBe(true);
  });

  it("catches a soft block that serves a stub with a 200", () => {
    expect(
      judgeEdgeBlock({ ...base, botStatus: 200, browserStatus: 200, botBytes: 100, browserBytes: 10_000 })
        .blocked,
    ).toBe(true);
  });

  it("passes a site that treats bots and browsers identically", () => {
    expect(
      judgeEdgeBlock({ ...base, botStatus: 200, browserStatus: 200 }).blocked,
    ).toBe(false);
  });

  it("tolerates ordinary page-to-page variation", () => {
    // Pages differ between requests. A tight threshold here sends the user to
    // argue with their CDN about nothing.
    expect(
      judgeEdgeBlock({ ...base, botStatus: 200, browserStatus: 200, botBytes: 8_500, browserBytes: 10_000 })
        .blocked,
    ).toBe(false);
  });

  it("does not accuse a site whose browser request also failed", () => {
    // Both 404 — that is a broken URL, not discrimination against bots.
    expect(
      judgeEdgeBlock({ ...base, botStatus: 404, browserStatus: 404 }).blocked,
    ).toBe(false);
  });

  it("treats a failed bot request as blocked", () => {
    expect(
      judgeEdgeBlock({ ...base, botStatus: null, browserStatus: 200, botBytes: 0 }).blocked,
    ).toBe(true);
  });
});

describe("visibleTextWords()", () => {
  it("does not count script or style contents as prose", () => {
    // A JS bundle is not an essay. Counting it makes an empty page look full.
    const html = `<html><head><style>${"a{color:red}".repeat(50)}</style>
      <script>${"var x = 1;".repeat(200)}</script></head>
      <body><p>Only these five words count</p></body></html>`;
    expect(visibleTextWords(html)).toBe(5);
  });

  it("ignores noscript filler", () => {
    expect(
      visibleTextWords("<noscript>Enable JavaScript to view this site</noscript><p>one two</p>"),
    ).toBe(2);
  });

  it("returns 0 for an empty SPA shell", () => {
    expect(visibleTextWords('<html><body><div id="root"></div></body></html>')).toBe(0);
  });
});

describe("probeAiAccess() — the productlaunchos.com shape", () => {
  const HOMEPAGE = `<html><body>${"<p>word</p>".repeat(400)}</body></html>`;

  function realisticNet(): FetchImpl {
    return net({
      // apex redirects to www, and every file lives on www
      "https://productlaunchos.com/": {
        body: HOMEPAGE,
        url: "https://www.productlaunchos.com/",
      },
      "https://www.productlaunchos.com/": { body: HOMEPAGE },
      "https://www.productlaunchos.com/robots.txt": {
        body: "User-agent: *\nAllow: /\n\nSitemap: https://www.productlaunchos.com/sitemap.xml\n",
      },
    });
  }

  it("resolves to www and reads the robots.txt that lives there", async () => {
    const out = await probeAiAccess(
      { siteUrl: "https://productlaunchos.com/", blogPath: "/blog/" },
      realisticNet(),
    );
    expect(out.canonicalOrigin).toBe("https://www.productlaunchos.com");
    expect(out.redirected).toBe(true);
    expect(out.robots.state).toBe("ok");
    expect(out.parsedRobots.sitemaps).toHaveLength(1);
  });

  it("reports every AI agent allowed", async () => {
    const out = await probeAiAccess(
      { siteUrl: "https://productlaunchos.com/", blogPath: "/blog/" },
      realisticNet(),
    );
    expect(out.agents.every((a) => !a.blocked)).toBe(true);
  });

  it("reports both llms.txt files missing", async () => {
    const out = await probeAiAccess(
      { siteUrl: "https://productlaunchos.com/", blogPath: "/blog/" },
      realisticNet(),
    );
    expect(out.llmsFiles.every((f) => !f.present)).toBe(true);
  });

  it("clears the site of edge blocking", async () => {
    const out = await probeAiAccess(
      { siteUrl: "https://productlaunchos.com/", blogPath: "/blog/" },
      realisticNet(),
    );
    expect(out.edge.every((e) => !e.blocked)).toBe(true);
  });

  it("finds the text in the raw HTML that a ratio test would have missed", async () => {
    // 400 words of real copy inside a very large Framer document. Judged on
    // the absolute count, this passes; judged as a share of bytes it would
    // have been called an empty JavaScript shell.
    const out = await probeAiAccess(
      { siteUrl: "https://productlaunchos.com/", blogPath: "/blog/" },
      realisticNet(),
    );
    expect(out.jsGating?.words).toBeGreaterThanOrEqual(MIN_HTML_WORDS);
    expect(out.jsGating?.contentInHtml).toBe(true);
  });

  it("flags a site whose text only exists after JavaScript runs", async () => {
    const fetchImpl = net({
      "https://spa.example/": {
        body: '<html><body><div id="root"></div><script>app()</script></body></html>',
      },
      "https://spa.example/robots.txt": { body: "User-agent: *\nAllow: /" },
    });
    const out = await probeAiAccess(
      { siteUrl: "https://spa.example/", blogPath: "/blog/" },
      fetchImpl,
    );
    expect(out.jsGating).toMatchObject({ words: 0, contentInHtml: false });
  });
});
