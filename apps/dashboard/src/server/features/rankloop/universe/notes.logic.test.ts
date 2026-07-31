import { describe, expect, it } from "vitest";
import {
  IMPRESSIONS_28_NOTE_KEY,
  mergeNotes,
  readImpressions28,
} from "./notes.logic";

describe("readImpressions28", () => {
  it("reads the key the universe step writes", () => {
    // Pinned deliberately: this string is the contract between S5's upsert
    // path and the page planner's volume imputation, and a rename on one side
    // alone breaks nothing loudly.
    expect(IMPRESSIONS_28_NOTE_KEY).toBe("impr28");
    expect(readImpressions28('{"impr28":250}')).toBe(250);
  });

  it("answers null for a row no source ever measured", () => {
    expect(readImpressions28(null)).toBeNull();
    expect(readImpressions28('{"variants":["a"]}')).toBeNull();
  });

  it("survives a notesJson that isn't JSON at all", () => {
    expect(readImpressions28("{oops")).toBeNull();
  });
});

describe("mergeNotes", () => {
  it("keeps Search Console evidence a later source knows nothing about", () => {
    // An autocomplete run landing on a query GSC already proved must not
    // erase impr28 — that number is the planner's whole demand signal for
    // long-tail rows.
    const merged = mergeNotes('{"impr28":250,"variants":["a"]}', {
      pool: "question",
    });

    expect(readImpressions28(merged)).toBe(250);
    expect(JSON.parse(merged ?? "{}")).toEqual({
      impr28: 250,
      variants: ["a"],
      pool: "question",
    });
  });

  it("lets a re-run of the same source overwrite its own facts", () => {
    expect(mergeNotes('{"impr28":250}', { impr28: 310 })).toBe(
      '{"impr28":310}',
    );
  });

  it("stays null rather than storing an empty object", () => {
    expect(mergeNotes(null, {})).toBeNull();
  });
});
