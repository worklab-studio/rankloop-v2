import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanFeedTitle,
  harvestQuestions,
  isQuestionShaped,
  parseRedditFeed,
  parseStackExchangeFeed,
  REDDIT_MAX_ATTEMPTS,
  REDDIT_RETRY_BACKOFF_MULTIPLIER,
  REDDIT_RSS_GAP_MS,
  STACKEXCHANGE_TAG_GAP_MS,
  toHarvestCandidate,
} from "./harvest";

function stackExchangeFeed(
  entries: Array<{ title: string; id: string; rank?: number }>,
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:re="http://purl.org/atompub/rank/1.0">
${entries
  .map(
    (entry) => `  <entry>
    <id>${entry.id}</id>
    <title type="text">${entry.title}</title>
    <re:rank scheme="http://superuser.com/">${entry.rank ?? 0}</re:rank>
  </entry>`,
  )
  .join("\n")}
</feed>`;
}

function redditFeed(entries: Array<{ title: string; href: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${entries
  .map(
    (entry) => `  <entry>
    <link href="${entry.href}"/>
    <title>${entry.title}</title>
  </entry>`,
  )
  .join("\n")}
</feed>`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** fetch's first argument is a string | URL | Request union; stringifying it
 *  blindly would read "[object Object]" for a Request. */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then((value) => value);
  await vi.runAllTimersAsync();
  return settled;
}

describe("pacing constants", () => {
  it("keeps v1's measured gaps", () => {
    // Verified in production against both feeds — StackExchange tag feeds are
    // 429-happy under bursts, and Reddit 429s a second /new/.rss seconds later
    // even under a custom UA. Lowering either of these is how a free source
    // stops being free.
    expect(STACKEXCHANGE_TAG_GAP_MS).toBe(2_000);
    expect(REDDIT_RSS_GAP_MS).toBe(20_000);
    expect(REDDIT_RETRY_BACKOFF_MULTIPLIER).toBe(2);
    expect(REDDIT_MAX_ATTEMPTS).toBe(2);
  });
});

describe("parseStackExchangeFeed", () => {
  it("reads title, canonical url and vote count", () => {
    const entries = parseStackExchangeFeed(
      stackExchangeFeed([
        {
          title: "How do I descale a kettle?",
          id: "https://superuser.com/q/1",
          rank: 12,
        },
      ]),
    );
    expect(entries).toEqual([
      {
        title: "How do I descale a kettle?",
        url: "https://superuser.com/q/1",
        votes: 12,
      },
    ]);
  });

  it("returns nothing for an unparseable body rather than throwing", () => {
    expect(parseStackExchangeFeed("<html>429 Too Many Requests")).toEqual([]);
  });
});

describe("parseRedditFeed", () => {
  it("reads the link href attribute, not the element's text", () => {
    // A childless <link href=.../> is falsy in most languages' truthiness
    // rules; reading it as text silently loses every url.
    const entries = parseRedditFeed(
      redditFeed([
        { title: "Is there an app that tracks this?", href: "https://r/1" },
      ]),
    );
    expect(entries).toEqual([
      {
        title: "Is there an app that tracks this?",
        url: "https://r/1",
        votes: null,
      },
    ]);
  });
});

describe("cleanFeedTitle", () => {
  it("strips moderation suffixes, entities and the trailing question mark", () => {
    expect(cleanFeedTitle("How do I descale a kettle? [closed]")).toBe(
      "How do I descale a kettle",
    );
    expect(cleanFeedTitle("Why  is   this   slow??")).toBe("Why is this slow");
  });
});

describe("isQuestionShaped", () => {
  it("admits questions and rejects announcements", () => {
    expect(isQuestionShaped("How do I descale a kettle?")).toBe(true);
    expect(isQuestionShaped("Anyone else seeing this")).toBe(true);
    expect(isQuestionShaped("My kettle broke today")).toBe(false);
    expect(isQuestionShaped("PSA: new firmware is out")).toBe(false);
  });

  it("checks the raw title, before the trailing ? is stripped", () => {
    // "Kettle keeps beeping?" only reads as a question because of the mark.
    expect(isQuestionShaped("Kettle keeps beeping?")).toBe(true);
    expect(isQuestionShaped(cleanFeedTitle("Kettle keeps beeping?"))).toBe(
      false,
    );
  });
});

describe("toHarvestCandidate", () => {
  it("pool-flags the row and keeps its provenance", () => {
    const candidate = toHarvestCandidate({
      entry: {
        title: "How do I descale a kettle?",
        url: "https://superuser.com/q/1",
        votes: 12,
      },
      seed: "stackexchange/kettle",
      origin: "stackexchange",
      seen: new Set(),
    });
    expect(candidate).toEqual({
      keyword: "how do i descale a kettle",
      source: "harvest",
      seed: "stackexchange/kettle",
      notes: {
        pool: "fresh_question",
        origin: "stackexchange",
        url: "https://superuser.com/q/1",
        votes: 12,
      },
    });
  });

  it("drops titles that are not questions and repeats across both feeds", () => {
    const seen = new Set<string>();
    const entry = {
      title: "How do I descale a kettle?",
      url: "https://superuser.com/q/1",
      votes: null,
    };
    expect(
      toHarvestCandidate({
        entry,
        seed: "r/coffee",
        origin: "reddit",
        seen,
      }),
    ).not.toBeNull();
    // The same question on the other feed is one backlog row, not two.
    expect(
      toHarvestCandidate({
        entry,
        seed: "stackexchange/kettle",
        origin: "stackexchange",
        seen,
      }),
    ).toBeNull();
    expect(
      toHarvestCandidate({
        entry: { title: "My kettle broke", url: "", votes: null },
        seed: "r/coffee",
        origin: "reddit",
        seen,
      }),
    ).toBeNull();
  });
});

describe("harvestQuestions", () => {
  it("paces tags 2s apart and subs 20s apart", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("reddit.com")) {
        return Promise.resolve(
          new Response(
            redditFeed([{ title: "Is this normal?", href: "https://r/1" }]),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          stackExchangeFeed([
            { title: "How do I fix this?", id: "https://se/1", rank: 3 },
          ]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    const candidates = await runWithTimers(
      harvestQuestions({
        stackExchangeSite: "superuser.com",
        stackExchangeTags: ["kettle", "descaling"],
        subreddits: ["coffee", "espresso"],
      }),
    );

    const delays = sleepSpy.mock.calls.map(([, delay]) => delay);
    // One inter-tag gap (two tags) and one inter-sub gap (two subs) — the
    // first of each runs immediately.
    expect(delays.filter((d) => d === STACKEXCHANGE_TAG_GAP_MS)).toHaveLength(
      1,
    );
    expect(delays.filter((d) => d === REDDIT_RSS_GAP_MS)).toHaveLength(1);
    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "how do i fix this",
      "is this normal",
    ]);
  });

  it("retries a 429 subreddit exactly once, at twice the gap", async () => {
    let redditCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (!requestUrl(input).includes("reddit.com")) {
        return Promise.resolve(new Response(stackExchangeFeed([])));
      }
      redditCalls += 1;
      if (redditCalls === 1) {
        return Promise.resolve(new Response("", { status: 429 }));
      }
      return Promise.resolve(
        new Response(
          redditFeed([{ title: "Why is this slow?", href: "https://r/2" }]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    const candidates = await runWithTimers(
      harvestQuestions({
        stackExchangeTags: [],
        subreddits: ["coffee"],
      }),
    );

    expect(redditCalls).toBe(2);
    expect(
      sleepSpy.mock.calls.some(
        ([, delay]) =>
          delay === REDDIT_RSS_GAP_MS * REDDIT_RETRY_BACKOFF_MULTIPLIER,
      ),
    ).toBe(true);
    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "why is this slow",
    ]);
  });

  it("gives up on a sub after the one retry and keeps the rest of the harvest", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (requestUrl(input).includes("reddit.com")) {
        return Promise.resolve(new Response("", { status: 429 }));
      }
      return Promise.resolve(
        new Response(
          stackExchangeFeed([
            { title: "How do I fix this?", id: "https://se/1" },
          ]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await runWithTimers(
      harvestQuestions({
        stackExchangeSite: "superuser.com",
        stackExchangeTags: ["kettle"],
        subreddits: ["coffee"],
      }),
    );

    // Two reddit attempts, no third — and the StackExchange half still landed.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).includes("reddit.com"),
      ),
    ).toHaveLength(REDDIT_MAX_ATTEMPTS);
    expect(candidates.map((candidate) => candidate.keyword)).toEqual([
      "how do i fix this",
    ]);
  });

  it("reads nothing when a StackExchange site has no tags", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await runWithTimers(
      harvestQuestions({
        stackExchangeSite: "superuser.com",
        stackExchangeTags: [],
        subreddits: [],
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(candidates).toEqual([]);
  });
});
