import { z } from "zod";
import { jobSchema } from "./job.js";

/**
 * Input schema for the analyze_jobs tool.
 *
 * Either `jobs` (array of structured objects) or `csv_text` (raw CSV with
 * fuzzy-matched headers) must be provided. If both are present, they are
 * merged — jobs from `csv_text` are appended to the structured `jobs` array.
 */
export const analyzeJobsSchema = z.object({
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
});

export type AnalyzeJobsInput = z.infer<typeof analyzeJobsSchema>;
