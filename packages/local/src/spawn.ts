/** Spawning the user's AI CLI.
 *
 * The prompt goes over STDIN, never argv: no shell, no escaping, no argv
 * length ceiling, and nothing readable in `ps` output while a generation
 * runs. The command and args come from config verbatim — `claude -p` by
 * default, but anything that reads stdin and prints the answer works. */

import { spawn } from "node:child_process";

export interface WriterRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Set for failures that never produced a process, e.g. command not found. */
  detail: string | null;
}

export function runWriter(
  input: { command: string; args: string[]; timeoutMin: number },
  prompt: string,
): Promise<WriterRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
        detail: error instanceof Error ? error.message : "spawn failed",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // A wedged CLI on a cron accumulates one stuck process per interval,
    // forever. SIGKILL rather than SIGTERM: a process that ignored its own
    // timeout is not going to honour a polite signal either.
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(1, input.timeoutMin) * 60_000,
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const settle = (run: WriterRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    child.on("error", (error) => {
      // ENOENT lands here, not in the spawn call. "claude: command not
      // found" must reach the user as those words, not as an empty draft
      // that fails every law.
      settle({
        ok: false,
        stdout,
        stderr,
        code: null,
        timedOut,
        detail: error.message,
      });
    });

    child.on("close", (code) => {
      settle({
        ok: code === 0 && !timedOut && stdout.trim() !== "",
        stdout,
        stderr,
        code,
        timedOut,
        detail: timedOut
          ? `the writer ran past ${input.timeoutMin} minutes and was killed`
          : code !== 0
            ? `the writer exited with code ${code}`
            : stdout.trim() === ""
              ? "the writer exited cleanly but printed nothing"
              : null,
      });
    });

    child.stdin?.end(prompt);
  });
}
