import { z } from "zod";
import { jobSchema } from "./job.js";

/**
 * Input schema for the cash_flow tool.
 *
 * Either `jobs` (array of structured objects) or `csv_text` (raw CSV with
 * fuzzy-matched headers) must be provided. If both are present, they are
 * merged — jobs from `csv_text` are appended to the structured `jobs` array.
 */
export const cashFlowSchema = z.object({
  jobs: z
    .array(jobSchema)
    .optional()
    .describe("Array of structured job objects. Optional if csv_text is provided."),
  csv_text: z
    .string()
    .optional()
    .describe(
      "Raw CSV text. Headers are fuzzy-matched against the Job schema — e.g., 'Job Name', 'Project', 'Work Order' all map to jobName."
    ),
  starting_balance: z
    .number()
    .optional()
    .default(0)
    .describe("Current cash on hand, in dollars. Defaults to 0."),
  forecast_days: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .default(90)
    .describe("How many days ahead to project cash flow. Defaults to 90."),
  collection_lag_days: z
    .number()
    .int()
    .min(0)
    .max(180)
    .optional()
    .default(30)
    .describe("Average days between invoice and payment receipt. Defaults to 30."),
});

export type CashFlowInput = z.infer<typeof cashFlowSchema>;
