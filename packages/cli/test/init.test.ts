/** `rankloop init`: what it writes, what it refuses to touch, and what it
 * says the second time. */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bufferIo } from "../src/io.ts";
import { runInit } from "../src/init.ts";
import { VERSION } from "../src/version.ts";

const SCAFFOLD = [
  "rankloop.json",
  "rankloop/writer-prompt.md",
  "rankloop/post-template.md",
  ".github/workflows/rankloop-check.yml",
];

/** A copy of a fixture repo, so init writes into scratch space. */
function scratch(fixture?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rankloop-init-"));
  if (fixture) {
    cpSync(fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), root, {
      recursive: true,
    });
  }
  return root;
}

describe("runInit()", () => {
  it("scaffolds the four files and names them all", async () => {
    const root = scratch("astro-app");
    const io = bufferIo();

    expect(await runInit({ dir: root, yes: true }, io)).toBe(0);

    for (const path of SCAFFOLD) {
      expect(existsSync(join(root, path)), path).toBe(true);
      expect(io.text).toContain(`created   ${path}`);
    }
    expect(io.text).toContain("next:");
  });

  it("writes the detected content directory into the config and the workflow", async () => {
    const root = scratch("hugo-site");
    await runInit({ dir: root, yes: true }, bufferIo());

    const config: unknown = JSON.parse(readFileSync(join(root, "rankloop.json"), "utf8"));
    expect(config).toMatchObject({
      contentDir: "content/posts",
      site: { blogPath: "posts", mode: "markdown" },
    });

    const workflow = readFileSync(join(root, ".github/workflows/rankloop-check.yml"), "utf8");
    expect(workflow).toContain('- "content/posts/**"');
  });

  it("pins the CLI version in the scaffolded workflow", async () => {
    const root = scratch();
    await runInit({ dir: root, yes: true }, bufferIo());

    const workflow = readFileSync(join(root, ".github/workflows/rankloop-check.yml"), "utf8");
    expect(workflow).toContain(`npx rankloop@${VERSION} check --format=github`);
  });

  // A gate that fails on the first pull request of a fresh repo is a gate
  // people learn to click past, so the step stays commented until the package
  // is installable — and the job says so rather than passing quietly.
  it("ships the gate switched off while the package is unpublished, and says so", async () => {
    const root = scratch();
    const io = bufferIo();
    await runInit({ dir: root, yes: true }, io);

    const workflow = readFileSync(join(root, ".github/workflows/rankloop-check.yml"), "utf8");
    expect(workflow).toContain(`# - run: npx rankloop@${VERSION} check --format=github`);
    expect(workflow).toContain("laws not enforced yet");
    expect(workflow).toContain("::notice::");
    expect(io.text).toContain(`rankloop ${VERSION} is not published to npm yet`);
  });

  // blogPath is the only value in the config that nothing on disk can confirm,
  // and every internal link a brief hands a writer is built from it.
  it("names blogPath as the guess worth checking, with the value it guessed", async () => {
    const root = scratch("hugo-site");
    const io = bufferIo();
    await runInit({ dir: root, yes: true }, io);

    expect(io.text).toContain('verify: site.blogPath reads "posts"');
  });

  it("reports nothing to do on a second run and leaves edits alone", async () => {
    const root = scratch("next-app");
    await runInit({ dir: root, yes: true }, bufferIo());

    const promptPath = join(root, "rankloop/writer-prompt.md");
    writeFileSync(promptPath, "# my own voice, thanks\n", "utf8");

    const io = bufferIo();
    expect(await runInit({ dir: root, yes: true }, io)).toBe(0);
    expect(io.text).toBe("nothing to do; every scaffold file already exists");
    expect(readFileSync(promptPath, "utf8")).toBe("# my own voice, thanks\n");
  });

  it("restores only the missing file when part of the scaffold is gone", async () => {
    const root = scratch();
    await runInit({ dir: root, yes: true }, bufferIo());
    rmSync(join(root, ".github/workflows/rankloop-check.yml"));

    const io = bufferIo();
    expect(await runInit({ dir: root, yes: true }, io)).toBe(0);
    expect(io.lines.filter((line) => line.startsWith("created"))).toEqual([
      "created   .github/workflows/rankloop-check.yml",
    ]);
  });

  it("takes the answers when asked, and re-derives the mode from the new path", async () => {
    const root = scratch("html-site");
    const io = bufferIo();
    const asked: string[] = [];
    const answers = ["blog", "https://coffee.example"];

    const code = await runInit(
      {
        dir: root,
        yes: false,
        interactive: true,
        ask: (question) => {
          asked.push(question);
          return Promise.resolve(answers.shift() ?? "");
        },
      },
      io,
    );

    expect(code).toBe(0);
    expect(asked[0]).toContain("content directory [blog]");
    expect(io.text).toContain("detected plain markdown, posts in blog (html)");

    const config: unknown = JSON.parse(readFileSync(join(root, "rankloop.json"), "utf8"));
    expect(config).toMatchObject({
      contentDir: "blog",
      site: { url: "https://coffee.example", mode: "html" },
    });
  });

  it("refuses to guess silently when there is no terminal and no --yes", async () => {
    const io = bufferIo();
    const root = scratch();

    expect(await runInit({ dir: root, yes: false, interactive: false }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("--yes");
    expect(existsSync(join(root, "rankloop.json"))).toBe(false);
  });

  it("scaffolds a usable default when no content directory exists yet", async () => {
    const root = scratch();
    expect(await runInit({ dir: root, yes: true }, bufferIo())).toBe(0);

    const config: unknown = JSON.parse(readFileSync(join(root, "rankloop.json"), "utf8"));
    expect(config).toMatchObject({ contentDir: "content/blog" });
  });
});
