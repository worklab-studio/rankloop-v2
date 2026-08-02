// The AI access probe (spec 0027, card 3).
//
// robots.txt answers one question and the other three failures are invisible
// to it: a perfect robots.txt in front of a Cloudflare rule that 403s every
// bot, an llms.txt that was never written, and a page whose text only exists
// after JavaScript runs. This module does the I/O for all four and hands
// pure verdicts to robots.logic.ts.
//
// Every network call goes through an injected `fetchImpl` so the whole thing
// is testable without a network — see aiAccess.test.ts.

import {
  aiAccessVerdicts,
  parseRobots,
  type AgentVerdict,
  type ParsedRobots,
} from "@/server/features/rankloop/verdict/robots.logic";

// ---------------------------------------------------------------------------
// User agents
// ---------------------------------------------------------------------------

/**
 * Real UA strings, not invented ones.
 *
 * An edge rule that blocks AI matches on the UA string it sees in production,
 * so probing with a made-up `rankloop-probe/1.0` would sail through the exact
 * rule we are trying to detect and report the site open. These are the
 * strings the operators publish.
 */
export const PROBE_BOT_AGENTS = [
  {
    name: "ClaudeBot",
    ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  },
  {
    name: "GPTBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  },
] as const;

export const PROBE_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const TIMEOUT_MS = 15_000;

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

// ---------------------------------------------------------------------------
// robots.txt retrieval
// ---------------------------------------------------------------------------

/**
 * The three outcomes RFC 9309 gives different meanings to.
 *
 * `absent` (4xx) means everything is permitted — the standard's default, not
 * a problem. `unavailable` (5xx or a network failure) is the opposite and is
 * the one people miss: a crawler that cannot read robots.txt is required to
 * back off, so a 500 on this one file quietly de-indexes a whole site. It is
 * worth a finding of its own.
 */
export type RobotsFetch =
  | { state: "ok"; url: string; text: string }
  | { state: "absent"; url: string; status: number }
  | { state: "unavailable"; url: string; status: number | null; detail: string };

export async function fetchRobots(
  origin: string,
  fetchImpl: FetchImpl,
): Promise<RobotsFetch> {
  const url = new URL("/robots.txt", origin).toString();
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": PROBE_BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 500) {
      return {
        state: "unavailable",
        url,
        status: res.status,
        detail: `robots.txt returned ${res.status}`,
      };
    }
    if (res.status >= 400) return { state: "absent", url, status: res.status };
    return { state: "ok", url, text: await res.text() };
  } catch (error) {
    return {
      state: "unavailable",
      url,
      status: null,
      detail: error instanceof Error ? error.message : "network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Canonical origin
// ---------------------------------------------------------------------------

/**
 * Follow redirects once to find the origin the site actually serves from.
 *
 * Not a nicety. productlaunchos.com 308s to www.productlaunchos.com, and
 * every one of robots.txt, llms.txt and sitemap.xml lives on the www host —
 * so a probe that trusts the entered domain fetches four redirects, reads
 * zero files, and reports a healthy site as having no robots.txt at all.
 */
export async function resolveOrigin(
  siteUrl: string,
  fetchImpl: FetchImpl,
): Promise<{ origin: string; redirected: boolean; reachable: boolean }> {
  const entered = new URL(siteUrl);
  try {
    const res = await fetchImpl(entered.toString(), {
      headers: { "user-agent": PROBE_BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const final = new URL(res.url || entered.toString());
    return {
      origin: final.origin,
      redirected: final.origin !== entered.origin,
      reachable: res.status < 400,
    };
  } catch {
    return { origin: entered.origin, redirected: false, reachable: false };
  }
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

export interface LlmsFileCheck {
  path: "/llms.txt" | "/llms-full.txt";
  present: boolean;
  status: number | null;
}

/**
 * Both llms.txt files. A miss is the cheapest finding on the card to close:
 * the engine already generates both from the published corpus (`wire.ts`),
 * so the fix ships the file content, not instructions for writing one.
 */
export async function checkLlmsFiles(
  origin: string,
  fetchImpl: FetchImpl,
): Promise<LlmsFileCheck[]> {
  const paths = ["/llms.txt", "/llms-full.txt"] as const;
  return Promise.all(
    paths.map(async (path) => {
      try {
        const res = await fetchImpl(new URL(path, origin).toString(), {
          headers: { "user-agent": PROBE_BROWSER_UA },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // A SPA that answers 200 with its shell for every unknown path would
        // otherwise register as "llms.txt present". Require text that starts
        // like the format actually specifies.
        const looksReal =
          res.status === 200 && isLlmsTxtShaped(await res.text());
        return { path, present: looksReal, status: res.status };
      } catch {
        return { path, present: false, status: null };
      }
    }),
  );
}

/** llms.txt opens with an H1 naming the site. An HTML shell does not. */
export function isLlmsTxtShaped(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return false;
  return body.trimStart().startsWith("#");
}

// ---------------------------------------------------------------------------
// Edge-level blocking
// ---------------------------------------------------------------------------

export interface EdgeBlockCheck {
  agent: string;
  botStatus: number | null;
  browserStatus: number | null;
  botBytes: number;
  browserBytes: number;
  blocked: boolean;
  reason: string | null;
}

/**
 * The check robots.txt cannot make.
 *
 * Cloudflare's "block AI scrapers" toggle, and every WAF rule like it, sits
 * in front of the origin and answers 403 to a bot UA no matter what
 * robots.txt says. The site looks open in every audit tool that only reads
 * the file. Comparing a real bot UA against a browser UA is the only way to
 * see it from outside.
 */
export function judgeEdgeBlock(input: {
  agent: string;
  botStatus: number | null;
  browserStatus: number | null;
  botBytes: number;
  browserBytes: number;
}): EdgeBlockCheck {
  const { agent, botStatus, browserStatus, botBytes, browserBytes } = input;
  const base = { agent, botStatus, browserStatus, botBytes, browserBytes };

  if (botStatus === null) {
    return { ...base, blocked: true, reason: "the request failed for the bot user agent" };
  }
  // A challenge or an outright refusal for the bot while the browser is
  // served is the signature, and 503 is included because that is what a
  // JS-challenge page answers with.
  if ([401, 403, 429, 503].includes(botStatus) && (browserStatus ?? 0) < 400) {
    return { ...base, blocked: true, reason: `HTTP ${botStatus} for the bot, ${browserStatus} for a browser` };
  }
  if (botStatus !== browserStatus) {
    return { ...base, blocked: true, reason: `HTTP ${botStatus} for the bot, ${browserStatus} for a browser` };
  }
  // Same status, far less content: a soft block that serves a stub. The
  // threshold is deliberately loose — pages legitimately vary between
  // requests, and a false accusation here sends the user to argue with their
  // CDN over nothing.
  if (browserBytes > 0 && botBytes < browserBytes * 0.4) {
    return {
      ...base,
      blocked: true,
      reason: `the bot received ${botBytes} bytes where a browser received ${browserBytes}`,
    };
  }
  return { ...base, blocked: false, reason: null };
}

async function fetchAs(
  url: string,
  ua: string,
  fetchImpl: FetchImpl,
): Promise<{ status: number | null; bytes: number; body: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": ua },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    return { status: res.status, bytes: body.length, body };
  } catch {
    return { status: null, bytes: 0, body: "" };
  }
}

// ---------------------------------------------------------------------------
// Content visible without JavaScript
// ---------------------------------------------------------------------------

/**
 * Words of real text in the raw HTML, with script/style/noscript removed
 * first — their contents are not text a reader or a crawler ever sees, and
 * leaving them in makes a bundle look like an essay.
 */
export function visibleTextWords(html: string): number {
  const withoutCode = html.replace(
    /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  const text = withoutCode.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return 0;
  return text.split(" ").length;
}

/**
 * Below this, a crawler that does not run JavaScript has nothing to index.
 * An absolute count on purpose: the obvious alternative, text as a share of
 * HTML bytes, false-positives on exactly the sites it is meant to reassure —
 * productlaunchos.com serves 2,293 real words inside 657 KB of Framer
 * markup, a 0.35% ratio that any ratio test would call empty.
 */
export const MIN_HTML_WORDS = 120;

export interface JsGatingCheck {
  url: string;
  words: number;
  /** Phrased as what we measured, never as what a crawler "would" see —
   *  we do not execute JavaScript and no finding may imply that we did. */
  contentInHtml: boolean;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface AiAccessProbe {
  enteredUrl: string;
  canonicalOrigin: string;
  redirected: boolean;
  reachable: boolean;
  robots: RobotsFetch;
  parsedRobots: ParsedRobots;
  agents: AgentVerdict[];
  llmsFiles: LlmsFileCheck[];
  edge: EdgeBlockCheck[];
  jsGating: JsGatingCheck | null;
}

export async function probeAiAccess(
  input: { siteUrl: string; blogPath: string },
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis),
): Promise<AiAccessProbe> {
  const { origin, redirected, reachable } = await resolveOrigin(
    input.siteUrl,
    fetchImpl,
  );

  // `origin` has no trailing slash; every other URL in this module is built
  // through `new URL(path, origin)`, so the homepage gets the same treatment
  // rather than being the one request that varies by a character.
  const homepage = new URL("/", origin).toString();

  // robots.txt and llms.txt are independent of each other and of the UA
  // comparison, so they overlap rather than queue.
  const [robots, llmsFiles, browser] = await Promise.all([
    fetchRobots(origin, fetchImpl),
    checkLlmsFiles(origin, fetchImpl),
    fetchAs(homepage, PROBE_BROWSER_UA, fetchImpl),
  ]);

  const bots = await Promise.all(
    PROBE_BOT_AGENTS.map(async (bot) => {
      const got = await fetchAs(homepage, bot.ua, fetchImpl);
      return judgeEdgeBlock({
        agent: bot.name,
        botStatus: got.status,
        browserStatus: browser.status,
        botBytes: got.bytes,
        browserBytes: browser.bytes,
      });
    }),
  );

  // An unavailable robots.txt is NOT the same as an absent one, but for the
  // per-agent table there is no file to quote either way; the distinction is
  // carried by `robots.state` and surfaces as its own finding.
  const robotsText = robots.state === "ok" ? robots.text : null;

  return {
    enteredUrl: input.siteUrl,
    canonicalOrigin: origin,
    redirected,
    reachable,
    robots,
    parsedRobots: parseRobots(robotsText ?? ""),
    agents: aiAccessVerdicts(robotsText, input.blogPath),
    llmsFiles,
    edge: bots,
    jsGating:
      browser.status === null
        ? null
        : {
            url: homepage,
            words: visibleTextWords(browser.body),
            contentInHtml: visibleTextWords(browser.body) >= MIN_HTML_WORDS,
          },
  };
}
