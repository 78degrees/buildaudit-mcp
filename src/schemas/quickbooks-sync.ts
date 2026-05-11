import { z } from "zod";

/**
 * Input schema for `quickbooks_sync` — pulls jobs and/or expenses from the
 * user's connected QBO file and returns BuildAudit-shaped data.
 *
 * The user must have connected QuickBooks first (see /qb/connect on the
 * worker). The Bearer API key carried by the MCP request identifies which
 * UserState DO to read tokens from.
 */
export const quickbooksSyncSchema = z.object({
  pull: z
    .enum(["jobs", "expenses", "both"])
    .default("both")
    .describe(
      "Which data to pull from QuickBooks. 'both' returns { jobs, expenses } so a single sync call can feed analyze_jobs + audit_expenses.",
    ),
});

export type QuickbooksSyncInput = z.infer<typeof quickbooksSyncSchema>;
