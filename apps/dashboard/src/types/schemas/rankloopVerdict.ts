import { z } from "zod";

// Inputs for the verdict endpoints (spec 0027). The project is re-derived
// from `requireProjectContext`; these only carry which project is meant.

export const getRankloopAiAccessSchema = z.object({
  projectId: z.string().uuid(),
});

export const runRankloopAiAccessSchema = z.object({
  projectId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// The stored probe
// ---------------------------------------------------------------------------

// `ai_access_snapshots.payload` is JSON written by whichever release ran the
// probe, so reading it is a trust boundary like any other. Casting the column
// to the current TypeScript type would compile and then throw on the first
// snapshot written before a field existed. This parses instead, and the
// service degrades to "run it again" rather than crashing the card.

const robotsRuleSchema = z.object({
  type: z.enum(["allow", "disallow"]),
  pattern: z.string(),
  line: z.number(),
});

const accessDecisionSchema = z.object({
  verdict: z.enum(["allowed", "blocked"]),
  matchedAgent: z.string().nullable(),
  rule: robotsRuleSchema.nullable(),
});

export const storedProbeSchema = z.object({
  enteredUrl: z.string(),
  canonicalOrigin: z.string(),
  redirected: z.boolean(),
  reachable: z.boolean(),
  robots: z.union([
    z.object({ state: z.literal("ok"), url: z.string(), text: z.string() }),
    z.object({ state: z.literal("absent"), url: z.string(), status: z.number() }),
    z.object({
      state: z.literal("unavailable"),
      url: z.string(),
      status: z.number().nullable(),
      detail: z.string(),
    }),
  ]),
  parsedRobots: z.object({
    groups: z.array(
      z.object({ agents: z.array(z.string()), rules: z.array(robotsRuleSchema) }),
    ),
    sitemaps: z.array(z.string()),
    unknownDirectives: z.array(
      z.object({ field: z.string(), line: z.number() }),
    ),
  }),
  agents: z.array(
    z.object({
      agent: z.object({
        name: z.string(),
        operator: z.string(),
        purpose: z.enum(["training", "search", "user-fetch"]),
      }),
      root: accessDecisionSchema,
      blog: accessDecisionSchema,
      blocked: z.boolean(),
    }),
  ),
  llmsFiles: z.array(
    z.object({
      path: z.enum(["/llms.txt", "/llms-full.txt"]),
      present: z.boolean(),
      status: z.number().nullable(),
    }),
  ),
  edge: z.array(
    z.object({
      agent: z.string(),
      botStatus: z.number().nullable(),
      browserStatus: z.number().nullable(),
      botBytes: z.number(),
      browserBytes: z.number(),
      blocked: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  jsGating: z
    .object({ url: z.string(), words: z.number(), contentInHtml: z.boolean() })
    .nullable(),
});
