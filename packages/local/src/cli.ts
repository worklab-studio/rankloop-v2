/** Argument parsing and dispatch, hand-rolled for the same reason the
 * `rankloop` CLI's is: zero dependencies, and a surface small enough that a
 * parser library would be the biggest thing in the package. */

export const VERSION = "0.1.0";

export const HELP = `rankloop-local ${VERSION} — rankloop's writing loop on your own machine.

Your CLI writes (claude -p by default), the server's laws grade, and a cron
keeps it moving. No API keys: the writer is whatever CLI you already pay
for, and a localhost dashboard needs no token.

  rankloop-local init                  set up from inside your website repo
                                       (detects stack, domain, content dir)
  rankloop-local doctor                what is ready, what is blocking, and
                                       the one thing to do next
  rankloop-local run [--watch]         work through approved proposals once
                                       (--watch: keep running on an interval)
      --every 30m                      watch interval (30m default; 15m min)
      --max N                          proposals per run (default 1)
      --project ID                     override the configured project
      --server URL                     override the configured dashboard URL
      --out DIR                        draft mode: where gated files land
      --buy-serp                       allow the brief one paid SERP fetch
  rankloop-local cron                  print the crontab / launchd lines
  rankloop-local help | version

Config: ~/.config/rankloop/local.json — see the README for the shape.
Repo mode (write, commit, push, verify live, report) turns on when
"repo.path" is set there; otherwise gated drafts land in --out.
`;

export const CRON_HELP = `# Every 30 minutes, one proposal per run, quiet unless something happens:
*/30 * * * * $HOME/.local/bin/rankloop-local run >> $HOME/.config/rankloop/local.log 2>&1

# macOS sleeps through cron. launchd runs missed jobs on wake — put this in
# ~/Library/LaunchAgents/dev.rankloop.local.plist and run:
#   launchctl load ~/Library/LaunchAgents/dev.rankloop.local.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rankloop.local</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/rankloop-local</string><string>run</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/rankloop-local.log</string>
  <key>StandardErrorPath</key><string>/tmp/rankloop-local.log</string>
</dict></plist>
`;

export interface ParsedArgs {
  command: "run" | "init" | "doctor" | "cron" | "help" | "version";
  watch: boolean;
  everyMin: number;
  flags: {
    server?: string;
    project?: string;
    out?: string;
    max?: number;
    buySerp?: boolean;
  };
  errors: string[];
}

/** `30m`, `1h`, `900s`, or bare minutes. Floors at 15 minutes: a generation
 *  can take several, and overlapping runs racing one state file is the
 *  failure this floor exists to make unreachable. */
export function parseEvery(value: string): number | null {
  const match = /^(\d+)\s*(m|h|s)?$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] ?? "m";
  const minutes = unit === "h" ? n * 60 : unit === "s" ? n / 60 : n;
  return Math.max(15, Math.ceil(minutes));
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: "run",
    watch: false,
    everyMin: 30,
    flags: {},
    errors: [],
  };

  const [first, ...rest] = argv;
  if (first === "help" || first === "--help" || first === "-h") {
    out.command = "help";
    return out;
  }
  if (first === "version" || first === "--version") {
    out.command = "version";
    return out;
  }
  if (first === "cron" || first === "init" || first === "doctor") {
    out.command = first;
    return out;
  }
  const args = first === "run" ? rest : first === undefined ? [] : [first, ...rest];
  if (first !== "run" && first !== undefined && first.startsWith("-") === false) {
    out.errors.push(`Unknown command "${first}" — try \`rankloop-local help\`.`);
    return out;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (value === undefined) out.errors.push(`${arg} needs a value`);
      return value ?? "";
    };
    switch (arg) {
      case "--watch":
        out.watch = true;
        break;
      case "--every": {
        const parsed = parseEvery(next());
        if (parsed === null) out.errors.push("--every takes 30m, 1h, or minutes");
        else out.everyMin = parsed;
        break;
      }
      case "--max": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) out.errors.push("--max takes a positive integer");
        else out.flags.max = n;
        break;
      }
      case "--project":
        out.flags.project = next();
        break;
      case "--server":
        out.flags.server = next();
        break;
      case "--out":
        out.flags.out = next();
        break;
      case "--buy-serp":
        out.flags.buySerp = true;
        break;
      default:
        out.errors.push(`Unknown flag "${arg}" — try \`rankloop-local help\`.`);
    }
  }
  return out;
}
