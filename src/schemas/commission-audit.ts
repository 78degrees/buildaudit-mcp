import { z } from "zod";
import { jobSchema } from "./job.js";

/**
 * Input schema for the commission_audit tool.
 *
 * Flags jobs where commission was paid despite margin falling below the
 * minimum floor, detects same-week rate inconsistencies, and calculates
 * total commission exposure.
 */
export const commissionAuditSchema = z.object({
  jobs: z
    .array(jobSchema)
    .optional()
    .describe("Array of structured job objects. Optional if csv_text is provided."),
  csv_text: z
    .string()
    .optional()
    .describe("Raw CSV/spreadsheet text. Headers are fuzzy-matched."),
  margin_floor: z
    .number()
    .optional()
    .default(0.35)
    .describe("Minimum gross margin threshold for commission eligibility. Default 35%."),
  commission_rate: z
    .number()
    .optional()
    .default(0.10)
    .describe("Expected commission rate as a decimal. Default 10%."),
});

export type CommissionAuditInput = z.infer<typeof commissionAuditSchema>;
