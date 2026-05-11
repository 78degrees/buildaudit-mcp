import { z } from "zod";
import { jobSchema } from "./job.js";

/**
 * Input schema for variance_alerts.
 *
 * Returns jobs whose cost overrun (actualCosts vs estimatedCosts) exceeds
 * `threshold_percent`, sorted by severity (largest variance first).
 */
export const varianceAlertsSchema = z.object({
  jobs: z
    .array(jobSchema)
    .optional()
    .describe("Array of structured job objects. Optional if csv_text is provided."),
  csv_text: z
    .string()
    .optional()
    .describe("Raw CSV text. Same fuzzy-header rules as analyze_jobs."),
  threshold_percent: z
    .number()
    .positive("threshold_percent must be > 0")
    .max(1000, "threshold_percent must be <= 1000")
    .default(25)
    .describe("Percent overrun above which a job is flagged. Default 25 (i.e., 25% over budget)."),
});

export type VarianceAlertsInput = z.infer<typeof varianceAlertsSchema>;
