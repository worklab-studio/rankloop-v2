/** rankloop.json — one file describing the whole site, exactly as the Python
 * rankloop.toml did. All niche knowledge lives here; all machinery lives in
 * code. The file is read, validated and handed to the engine as an
 * `EngineConfig`; nothing in this package invents a field the engine cannot
 * already read.
 *
 * Validation is hand-written rather than schema-driven because this package
 * ships zero runtime dependencies. The error messages carry the JSON path
 * (`site.blogPath`) because a CI log is the only debugger a user gets. */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defaultLaws } from "@rankloop/engine";
import type { EngineConfig, LawsConfig, SiteMode } from "@rankloop/engine";

export const CONFIG_NAME = "rankloop.json";

/** A user-facing failure: printed as-is, never as a stack trace. */
export class ConfigError extends Error {}

export interface LoadedConfig {
  /** Absolute path of the directory holding rankloop.json. */
  root: string;
  /** Absolute path of the content tree. */
  contentDir: string;
  /** contentDir as the user wrote it, for messages. */
  contentDirRelative: string;
  cfg: EngineConfig;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${CONFIG_NAME}: ${path} must be an object`);
  }
  return value as Json;
}

function label(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function str(source: Json, key: string, path: string, fallback?: string): string {
  const value = source[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${CONFIG_NAME}: ${label(path, key)} is required`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${CONFIG_NAME}: ${label(path, key)} must be a non-empty string`);
  }
  return value;
}

/** Free-text fields a site is allowed to leave blank. */
function optionalStr(source: Json, key: string, path: string): string {
  const value = source[key];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ConfigError(`${CONFIG_NAME}: ${label(path, key)} must be a string`);
  }
  return value;
}

function num(source: Json, key: string, path: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${CONFIG_NAME}: ${path}.${key} must be a number`);
  }
  return value;
}

function bool(source: Json, key: string, path: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${CONFIG_NAME}: ${path}.${key} must be true or false`);
  }
  return value;
}

function stringMap(value: unknown, path: string): Record<string, string> {
  const source = object(value, path);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(`${CONFIG_NAME}: ${path}.${key} must be a non-empty string`);
    }
    out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Overrides land on top of `defaultLaws()`, key by key: a config naming only
 * `wordMin` still inherits every threshold the engine calibrates later.
 * `bannedPhrases` is the exception — supplying it REPLACES the built-in list,
 * because a site that lists its own tells means the ones it left out. */
function lawsFrom(value: unknown): LawsConfig {
  const laws = defaultLaws();
  if (value === undefined) return laws;
  const source = object(value, "laws");

  const numbers = [
    "wordMin",
    "wordMax",
    "h2Min",
    "faqMin",
    "internalLinksMin",
    "titleMax",
    "descriptionMax",
    "keywordDensityMax",
  ] as const;
  for (const key of numbers) {
    const override = num(source, key, "laws");
    if (override !== undefined) laws[key] = override;
  }

  for (const key of ["banEmDash", "requireFirstPerson"] as const) {
    const override = bool(source, key, "laws");
    if (override !== undefined) laws[key] = override;
  }

  const phrases = source["bannedPhrases"];
  if (phrases !== undefined) {
    if (!Array.isArray(phrases) || phrases.some((p) => typeof p !== "string")) {
      throw new ConfigError(`${CONFIG_NAME}: laws.bannedPhrases must be an array of strings`);
    }
    laws.bannedPhrases = phrases as string[];
  }

  if (laws.wordMin > laws.wordMax) {
    throw new ConfigError(
      `${CONFIG_NAME}: laws.wordMin (${laws.wordMin}) is above laws.wordMax (${laws.wordMax}); no post could pass`,
    );
  }
  return laws;
}

function modeFrom(site: Json): SiteMode {
  const mode = str(site, "mode", "site", "markdown");
  if (mode !== "html" && mode !== "markdown") {
    throw new ConfigError(`${CONFIG_NAME}: site.mode must be "html" or "markdown"`);
  }
  return mode;
}

export function parseConfig(text: string, root: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${CONFIG_NAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const file = object(raw, "the config");
  const site = object(file["site"], "site");
  const contentDirRelative = str(file, "contentDir", "");

  // An absolute contentDir would make the config unusable on any other
  // machine, and CI is another machine.
  if (isAbsolute(contentDirRelative)) {
    throw new ConfigError(
      `${CONFIG_NAME}: contentDir must be relative to the config file, not absolute`,
    );
  }

  const taxonomy = stringMap(file["taxonomy"], "taxonomy");
  if (Object.keys(taxonomy).length === 0) {
    throw new ConfigError(
      `${CONFIG_NAME}: taxonomy needs at least one "Category": "hub-slug" entry — the category law checks against it`,
    );
  }

  return {
    root,
    contentDir: resolve(root, contentDirRelative),
    contentDirRelative,
    cfg: {
      site: {
        url: str(site, "url", "site"),
        name: str(site, "name", "site"),
        description: optionalStr(site, "description", "site"),
        blogPath: str(site, "blogPath", "site", "blog"),
        mode: modeFrom(site),
      },
      taxonomy,
      // The relevance regexes ARE the niche, and they belong to discovery.
      // No publish law reads them, so the offline gate leaves them empty
      // rather than asking a repo to carry a field it cannot use.
      keywords: { positive: [], negative: [], classify: [] },
      laws: lawsFrom(file["laws"]),
    },
  };
}

export function loadConfig(dir: string): LoadedConfig {
  const root = resolve(dir);
  const path = join(root, CONFIG_NAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`no ${CONFIG_NAME} in ${root}; run \`rankloop init\` first`);
  }
  return parseConfig(text, root);
}
