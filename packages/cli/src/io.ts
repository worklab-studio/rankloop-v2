/** Output is injected, never written directly by a command.
 *
 * Every command returns its exit code and prints through this interface, so a
 * test asserts on the exact lines a user sees instead of on a mocked console.
 * The bin is the only place that knows stdout exists. */

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: Io = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** Collects lines for tests; `text` is what the terminal would have shown. */
export function bufferIo(): Io & { lines: string[]; errors: string[]; text: string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    get text() {
      return lines.join("\n");
    },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  };
}
