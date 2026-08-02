import { z } from "zod";

// Inputs for the Grow armory (spec 0029).

export const getRankloopArmorySchema = z.object({
  projectId: z.string().uuid(),
});

export const seedRankloopArmorySchema = z.object({
  projectId: z.string().uuid(),
});

export const verifyRankloopLinksSchema = z.object({
  projectId: z.string().uuid(),
});

export const saveRankloopKitSchema = z.object({
  projectId: z.string().uuid(),
  kit: z.object({
    name: z.string().max(200),
    tagline: z.string().max(300),
    shortDescription: z.string().max(600),
    longDescription: z.string().max(4000),
    url: z.string().max(500),
    logoUrl: z.string().max(500).nullable(),
    categories: z.array(z.string().max(60)).max(12),
    pricing: z.string().max(120).nullable(),
    founder: z.string().max(120).nullable(),
    launchDate: z.string().max(40).nullable(),
  }),
});
