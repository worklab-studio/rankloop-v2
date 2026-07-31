import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { publishConnections } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

type PublishConnection = InferSelectModel<typeof publishConnections>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** What connection reads return to the client. The nested config mirrors the
 *  stored (encrypted) config's shape minus its secret: the application
 *  password never crosses the wire after save — it masks to a hasPassword
 *  flag (spec 0013 acceptance 4). */
export type MaskedPublishConnection = Pick<
  PublishConnection,
  "adapter" | "status" | "lastCheckedAt"
> & {
  config: {
    baseUrl: string;
    username: string;
    hasPassword: boolean;
  };
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getPublishConnectionSchema = z.object({
  projectId: z.string().uuid(),
});

export const savePublishConnectionSchema = z.object({
  projectId: z.string().uuid(),
  adapter: z.enum(publishConnections.adapter.enumValues),
  baseUrl: z
    .string()
    .url()
    .max(2000)
    .refine(
      (value) => value.startsWith("https://") || value.startsWith("http://"),
      "The site URL must start with http:// or https://",
    ),
  username: z.string().min(1).max(200),
  // Optional on edit: the masked read-back can't round-trip the password, so
  // an omitted value means "keep the stored one". WordPress application
  // passwords are 24 chars plus spaces; the cap is a sanity bound.
  applicationPassword: z.string().min(1).max(200).optional(),
});

export const testPublishConnectionSchema = z.object({
  projectId: z.string().uuid(),
});

// The editor's 70/165 charcount hints are guidance; these caps are the hard
// sanity bounds (Google truncates, it doesn't reject).
export const executeRetitleProposalSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
  newTitle: z.string().trim().min(1).max(300),
  newMetaDescription: z.string().trim().min(1).max(500).optional(),
});

const proposalActionSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

export const attestProposalSchema = proposalActionSchema;
export const getPushGuidanceSchema = proposalActionSchema;
export const getRetitleContextSchema = proposalActionSchema;
