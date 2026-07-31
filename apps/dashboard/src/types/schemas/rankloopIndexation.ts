import { z } from "zod";

// ---------------------------------------------------------------------------
// Server function inputs
// ---------------------------------------------------------------------------

export const getRankloopIndexationSchema = z.object({
  projectId: z.string().uuid(),
});
