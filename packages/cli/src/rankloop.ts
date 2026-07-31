#!/usr/bin/env node
/** The bin. The only file that knows a process exists.
 *
 * `process.exitCode` rather than `process.exit()`: a brief is written to
 * stdout and exiting hard can truncate a pipe mid-write. */

import { main } from "./cli.ts";
import { consoleIo } from "./io.ts";

process.exitCode = await main(process.argv.slice(2), consoleIo);
