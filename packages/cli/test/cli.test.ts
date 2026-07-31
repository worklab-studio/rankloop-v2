/** Argument parsing, dispatch, and the offline brief. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { bufferIo } from "../src/io.ts";
import { VERSION } from "../src/version.ts";
import { cleanSite } from "./site.ts";

describe("main()", () => {
  it("keeps VERSION in step with package.json, which the workflow pins", () => {
    const pkg: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    expect(pkg).toMatchObject({ version: VERSION, name: "rankloop" });
  });

  it("accepts --dir PATH and --dir=PATH alike", async () => {
    const site = cleanSite();
    for (const argv of [["check", "--dir", site.root], ["check", `--dir=${site.root}`]]) {
      const io = bufferIo();
      expect(await main(argv, io)).toBe(0);
      expect(io.text).toContain("all laws pass");
    }
  });

  it("rejects a --format nobody implements instead of silently checking", async () => {
    const site = cleanSite();
    const io = bufferIo();
    expect(await main(["check", "--dir", site.root, "--format=teamcity"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("expected");
  });

  it("exits 1 on no command, 0 on an asked-for help", async () => {
    const empty = bufferIo();
    expect(await main([], empty)).toBe(1);
    expect(empty.text).toContain("rankloop check");

    const asked = bufferIo();
    expect(await main(["help"], asked)).toBe(0);
  });

  it("prints the version alone for --version", async () => {
    const io = bufferIo();
    expect(await main(["--version"], io)).toBe(0);
    expect(io.text).toBe(VERSION);
  });

  it("names an unknown command rather than guessing at it", async () => {
    const io = bufferIo();
    expect(await main(["publish"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain('unknown command "publish"');
  });
});

describe("rankloop brief", () => {
  it("renders the laws, the taxonomy and only real link targets", async () => {
    const site = cleanSite();
    const io = bufferIo();
    expect(
      await main(["brief", "espresso", "grinder", "--dir", site.root], io, {
        today: "2026-08-01",
      }),
    ).toBe(0);

    expect(io.text).toContain('# Writer brief: "espresso grinder"');
    expect(io.text).toContain("Today's date is 2026-08-01");
    expect(io.text).toContain("- /blog/grinder-notes/");
    expect(io.text).toContain("- At least 2 internal links");
    // The offline brief has no SERP and says so instead of implying one.
    expect(io.text).toContain("No cached SERP for this keyword");
    expect(io.text).toContain("- Guides -> /blog/guides/");
  });

  it("refuses an empty keyword with a usage line", async () => {
    const site = cleanSite();
    const io = bufferIo();
    expect(await main(["brief", "--dir", site.root], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("usage: rankloop brief");
  });
});
