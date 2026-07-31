/** The boundary this package exists to hold.
 *
 * `rankloop check` is the offline laws gate. It runs in someone else's CI,
 * on someone else's source, with no account and no key, and the only reason
 * that is safe to promise is that there is nothing in here that could phone
 * home. Two proofs, because either one alone is weak: a source scan catches
 * code that is never executed by a test, and a runtime trap catches code that
 * reaches the network through a name the scan did not think of.
 *
 * The other half of the same promise: no model client. The grader is never
 * the author, so a dependency on a provider SDK would be a bug even if it
 * were never called. */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBrief } from "../src/brief.ts";
import { runCheck } from "../src/check.ts";
import { bufferIo } from "../src/io.ts";
import { cleanSite } from "./site.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const PACKAGE_JSON: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));
}

/** Every way a Node program can open a socket, plus the browser-shaped names
 * a bundler might polyfill. A new one lands here the day it is invented. */
const NETWORK_PATTERNS: [label: string, pattern: RegExp][] = [
  ["fetch(", /(^|[^.\w])fetch\s*\(/],
  ["node:http", /["']node:https?["']/],
  ["node:net", /["']node:(net|tls|dns|dgram|http2)["']/],
  ["undici", /["']undici["']/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["navigator.sendBeacon", /sendBeacon/],
];

/** Any client that would put a model on the grader's dependency graph. */
const MODEL_PATTERNS: RegExp[] = [
  /@anthropic-ai/,
  /["']openai["']/,
  /api\.anthropic\.com/,
  /api\.openai\.com/,
];

describe("the CLI makes no network call", () => {
  it("names no network API anywhere in src/", () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      // The test file's own patterns would otherwise trip the scan.
      for (const [label, pattern] of NETWORK_PATTERNS) {
        if (pattern.test(file.text)) offences.push(`${file.name}: ${label}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("declares exactly one runtime dependency, and it is the engine", () => {
    expect(PACKAGE_JSON).toMatchObject({
      dependencies: { "@rankloop/engine": "workspace:*" },
      engines: { node: ">=20" },
    });
    expect(
      Object.keys((PACKAGE_JSON as { dependencies: Record<string, string> }).dependencies),
    ).toEqual(["@rankloop/engine"]);
  });

  it("has no model client in src/ or in its dependencies", () => {
    for (const file of sourceFiles()) {
      for (const pattern of MODEL_PATTERNS) {
        expect(pattern.test(file.text), `${file.name} names a model client`).toBe(false);
      }
    }
  });

  it("completes a check with fetch replaced by a trap that fails the test", () => {
    const site = cleanSite();
    const calls: string[] = [];
    const original = globalThis.fetch;

    // Not a spy that records and returns: anything reaching for the network
    // from the check path must break loudly, here and in production.
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        calls.push(String(args[0]));
        throw new Error("the check path reached for the network");
      },
    });

    try {
      const io = bufferIo();
      expect(runCheck({ dir: site.root, format: "github" }, io)).toBe(0);
      expect(runBrief({ dir: site.root, keyword: "espresso grinder", today: "2026-08-01" }, io)).toBe(
        0,
      );
      expect(calls).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
