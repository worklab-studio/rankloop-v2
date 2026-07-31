import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOCOMPLETE_SEED_LIMIT,
  expandSeed,
  expandWithAutocomplete,
  normalizeSuggestion,
  parseOpenSearchSuggest,
  QUESTION_PREFIXES,
  SUGGEST_ENDPOINTS,
  SUGGEST_PACING_MS,
} from "./autocomplete";

function openSearchBody(suggestions: string[]): string {
  return JSON.stringify(["seed", suggestions]);
}

/** The pacing sleeps are real timers; run the whole suite on fake ones so a
 *  27-call expansion doesn't cost four seconds of wall clock. */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

describe("parseOpenSearchSuggest", () => {
  it("reads the suggestion array out of the OpenSearch envelope", () => {
    expect(
      parseOpenSearchSuggest(
        openSearchBody(["how to descale a kettle", "how to descale"]),
      ),
    ).toEqual(["how to descale a kettle", "how to descale"]);
  });

  it("returns nothing for a body that is not JSON", () => {
    // DDG has served an HTML error page under a 200 before now.
    expect(parseOpenSearchSuggest("<html>rate limited</html>")).toEqual([]);
  });

  it("returns nothing when the envelope changed shape", () => {
    expect(parseOpenSearchSuggest(JSON.stringify({ suggestions: [] }))).toEqual(
      [],
    );
    expect(parseOpenSearchSuggest(JSON.stringify(["seed"]))).toEqual([]);
  });

  it("drops non-string entries rather than failing the whole response", () => {
    expect(
      parseOpenSearchSuggest(JSON.stringify(["seed", ["ok phrase", 7, null]])),
    ).toEqual(["ok phrase"]);
  });
});

describe("expandSeed", () => {
  it("fans a seed out to the bare seed plus the eight question shapes", () => {
    const queries = expandSeed("espresso machine");
    expect(queries).toHaveLength(QUESTION_PREFIXES.length + 1);
    expect(queries[0]).toBe("espresso machine");
    expect(queries).toContain("how to espresso machine");
  });
});

describe("normalizeSuggestion", () => {
  it("rejects head terms, pasted sentences and repeats", () => {
    const seen = new Set<string>();
    expect(normalizeSuggestion("  Descale Kettle  ", seen)).toBe(
      "descale kettle",
    );
    // Same phrase, different casing — already seen.
    expect(normalizeSuggestion("descale kettle", seen)).toBeNull();
    // Under 8 chars is a head term a new site cannot win.
    expect(normalizeSuggestion("kettle", seen)).toBeNull();
    // Over 90 chars is autocomplete echoing back a pasted sentence.
    expect(normalizeSuggestion("a".repeat(91), seen)).toBeNull();
  });
});

describe("expandWithAutocomplete", () => {
  it("paces every call by 150ms and queries all three endpoints", async () => {
    // A fresh Response per call — a body can only be read once, and reusing
    // one would make every call after the first fail for the wrong reason.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(openSearchBody(["how to descale a kettle"])),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const candidates = await runWithTimers(
      expandWithAutocomplete({ seeds: ["kettle"], languageCode: "en" }),
    );

    // Nothing was logged as a failure — the happy path has to actually be
    // happy, or the pacing assertions below would pass over 27 broken calls.
    expect(infoSpy).not.toHaveBeenCalled();

    // 9 queries (bare seed + 8 prefixes) × 3 endpoints.
    const expectedCalls = (QUESTION_PREFIXES.length + 1) * 3;
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    expect(SUGGEST_ENDPOINTS.map((endpoint) => endpoint.name)).toEqual([
      "google",
      "bing",
      "ddg",
    ]);
    // One pacing sleep after every call, all at the polite gap.
    const pacingSleeps = sleepSpy.mock.calls.filter(
      ([, delay]) => delay === SUGGEST_PACING_MS,
    );
    expect(pacingSleeps).toHaveLength(expectedCalls);
    // Deduplicated across endpoints: three identical responses, one row.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      keyword: "how to descale a kettle",
      source: "autocomplete",
      seed: "kettle",
    });

    vi.unstubAllGlobals();
  });

  it("keeps going when one endpoint fails mid-step", async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      call += 1;
      const url = requestUrl(input);
      // Google dies from the fourth call on; Bing 429s throughout; DDG holds.
      if (url.includes("suggestqueries.google.com") && call > 3) {
        return Promise.reject(new Error("ECONNRESET"));
      }
      if (url.includes("api.bing.com")) {
        return Promise.resolve(new Response("", { status: 429 }));
      }
      return Promise.resolve(
        new Response(openSearchBody([`suggestion ${call}`])),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await runWithTimers(
      expandWithAutocomplete({ seeds: ["kettle"], languageCode: "en" }),
    );

    // The step still returns what the surviving endpoints found — one failing
    // free endpoint must never fail the source.
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((candidate) =>
        candidate.keyword.startsWith("suggestion"),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
  });

  it("stops at the seed limit so one run cannot blow the subrequest budget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(openSearchBody([]))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const seeds = Array.from(
      { length: AUTOCOMPLETE_SEED_LIMIT + 5 },
      (_, index) => `seed ${index}`,
    );
    await runWithTimers(expandWithAutocomplete({ seeds, languageCode: "en" }));

    expect(fetchMock).toHaveBeenCalledTimes(
      AUTOCOMPLETE_SEED_LIMIT * (QUESTION_PREFIXES.length + 1) * 3,
    );

    vi.unstubAllGlobals();
  });
});
