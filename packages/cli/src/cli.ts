/** Argument parsing and dispatch.
 *
 * Hand-rolled, because this package ships zero runtime dependencies and a
 * three-verb CLI is not worth a dependency that could one day grow a
 * postinstall script. Separate from the bin file so the tests can run the
 * whole surface, argv in and exit code out, without spawning a process. */

import { runBrief } from "./brief.ts";
import { runCheck } from "./check.ts";
import { runInit } from "./init.ts";
import type { Ask } from "./init.ts";
import type { Io } from "./io.ts";
import { VERSION } from "./version.ts";

export const HELP = `rankloop ${VERSION} — the publish laws, offline.

  rankloop init [--dir PATH] [--yes]      scaffold rankloop.json, the writer
                                          prompt, the post template and the
                                          CI workflow; never overwrites
  rankloop check [--dir PATH]             run the publish laws over the
                 [--format=github]        content tree; exit 1 on any failure
  rankloop brief KEYWORD [--dir PATH]     the writer brief from local config
                 [--category NAME]        and content (no SERP, no network)

This command never makes a network call. The engine is MIT and the laws run
on your machine, so the gate works in any repo, with or without a rankloop
account. Pipe a brief into whatever writes your posts; \`check\` decides
whether it ships.`;

interface Parsed {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

/** `--flag`, `--flag=value` and `--flag value` all work; the first bare word
 * is the command and the rest are positional. */
function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["dir", "format", "category"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (valued.has(body) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags.set(body, argv[++i]!);
      continue;
    }
    flags.set(body, true);
  }

  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export interface MainOptions {
  /** Overridden in tests; the bin passes nothing and gets the real terminal. */
  ask?: Ask;
  interactive?: boolean;
  today?: string;
}

export async function main(argv: string[], io: Io, options: MainOptions = {}): Promise<number> {
  const { command, positional, flags } = parse(argv);

  if (flags.has("version")) {
    io.out(VERSION);
    return 0;
  }
  if (command === null || command === "help" || flags.has("help")) {
    io.out(HELP);
    return command === null && !flags.has("help") ? 1 : 0;
  }

  const dir = stringFlag(flags, "dir") ?? process.cwd();

  switch (command) {
    case "init":
      return runInit(
        {
          dir,
          yes: flags.has("yes"),
          ask: options.ask,
          interactive: options.interactive,
        },
        io,
      );

    case "check": {
      const format = stringFlag(flags, "format");
      if (format !== undefined && format !== "github" && format !== "human") {
        io.err(`unknown --format=${format}; expected "human" or "github"`);
        return 1;
      }
      return runCheck({ dir, format: format ?? "human" }, io);
    }

    case "brief":
      return runBrief(
        {
          dir,
          keyword: positional.join(" "),
          category: stringFlag(flags, "category"),
          today: options.today,
        },
        io,
      );

    default:
      io.err(`unknown command "${command}"`);
      io.err(HELP);
      return 1;
  }
}
