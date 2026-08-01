/** `rankloop init` — scaffold the repo side of the agent path.
 *
 * Four files, and never an overwrite. A repo that already carries a
 * writer-prompt has a voice somebody wrote on purpose; a scaffolder that
 * clobbers it is a scaffolder nobody runs twice. Re-running reports "nothing
 * to do", which also makes it safe to put in a README as the first step.
 *
 * Detection is a guess the user confirms. `--yes` takes the guess as-is,
 * which is what CI and an agent both need. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_NAME } from "./config.ts";
import { blogPathFor, contentModeOf, detect } from "./detect.ts";
import type { Detection } from "./detect.ts";
import type { Io } from "./io.ts";
import { postTemplate, rankloopJson, workflow, writerPrompt } from "./templates.ts";
import type { ScaffoldInput } from "./templates.ts";
import { VERSION } from "./version.ts";

/** Asks one question and resolves with the answer, "" for an empty line. */
export type Ask = (question: string) => Promise<string>;

export interface InitOptions {
  dir: string;
  /** Take every detected default without asking. */
  yes: boolean;
  ask?: Ask;
  /** Defaults to `process.stdin.isTTY`; injected so a test can prove the
   *  non-interactive refusal without owning a terminal. */
  interactive?: boolean;
}

const DEFAULT_CONTENT_DIR = "content/blog";
const DEFAULT_SITE_URL = "https://example.com";

function scaffoldFiles(input: ScaffoldInput): Record<string, string> {
  return {
    [CONFIG_NAME]: rankloopJson(input),
    "rankloop/writer-prompt.md": writerPrompt(input),
    "rankloop/post-template.md": postTemplate(input),
    ".github/workflows/rankloop-check.yml": workflow(input),
  };
}

function writeIfAbsent(root: string, relativePath: string, contents: string): boolean {
  const path = join(root, relativePath);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return true;
}

/** Re-derive the two facts that follow from the content directory, so a user
 * who corrects the path does not also have to correct the mode. */
function redetect(root: string, detection: Detection, contentDir: string): Detection {
  if (contentDir === detection.contentDir) return detection;
  return {
    ...detection,
    contentDir,
    mode: contentModeOf(resolve(root, contentDir)) ?? detection.mode,
    blogPath: blogPathFor(contentDir),
  };
}

function describe(detection: Detection): string {
  if (!detection.contentDir) {
    return `detected ${detection.label}, but found no content directory`;
  }
  return `detected ${detection.label}, posts in ${detection.contentDir} (${detection.mode})`;
}

async function confirm(
  root: string,
  detection: Detection,
  ask: Ask,
  io: Io,
): Promise<{ detection: Detection; siteUrl: string }> {
  io.out(describe(detection));
  const suggested = detection.contentDir ?? DEFAULT_CONTENT_DIR;
  const answer = (await ask(`content directory [${suggested}]: `)).trim();
  const contentDir = (answer === "" ? suggested : answer).replace(/^\.\/+|\/+$/g, "");
  const url = (await ask(`site URL [${DEFAULT_SITE_URL}]: `)).trim();
  return {
    detection: redetect(root, detection, contentDir),
    siteUrl: url === "" ? DEFAULT_SITE_URL : url,
  };
}

export async function runInit(options: InitOptions, io: Io): Promise<number> {
  const root = resolve(options.dir);
  let detection = detect(root);
  let siteUrl = DEFAULT_SITE_URL;

  if (!options.yes) {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      io.err("no terminal to ask on; re-run with --yes to accept the detected defaults");
      return 1;
    }
    const ask = options.ask ?? readlineAsk;
    ({ detection, siteUrl } = await confirm(root, detection, ask, io));
  }

  const contentDir = detection.contentDir ?? DEFAULT_CONTENT_DIR;
  const input: ScaffoldInput = {
    detection: { ...detection, contentDir },
    contentDir,
    siteUrl,
    siteName: basename(root),
  };

  const created: string[] = [];
  for (const [relativePath, contents] of Object.entries(scaffoldFiles(input))) {
    if (writeIfAbsent(root, relativePath, contents)) created.push(relativePath);
  }

  if (created.length === 0) {
    io.out("nothing to do; every scaffold file already exists");
    return 0;
  }

  for (const relativePath of created) io.out(`created   ${relativePath}`);
  io.out("");
  io.out(`next: set site.url and the taxonomy in ${CONFIG_NAME}, write the voice block in`);
  io.out("      rankloop/writer-prompt.md, then `rankloop check` to see where the");
  io.out("      corpus stands.");
  io.out("");
  // The framework, the content directory and the mode are all read off the
  // repo; blogPath is the one value with nothing on disk to confirm it, and it
  // is load-bearing — every internal link a brief hands a writer is built from
  // it, so a wrong prefix means a post full of URLs that 404.
  io.out(`verify: site.blogPath reads "${input.detection.blogPath}" — the one value in the config`);
  io.out("      nothing on disk could confirm, and every internal link a brief hands");
  io.out("      a writer is built from it.");
  io.out("");
  // Handing someone a workflow that fails on their first PR is worse than
  // handing them none, so say plainly what it does and does not do today.
  io.out(`heads up: rankloop ${VERSION} is not published to npm yet, so the scaffolded`);
  io.out("      workflow ships with its check step commented out rather than red on");
  io.out("      every PR. Run `rankloop check` locally until it ships.");
  return 0;
}

/** The default `ask`: one question at a time on the real terminal. Imported
 * lazily so the module graph of `check` never touches readline. */
async function readlineAsk(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
