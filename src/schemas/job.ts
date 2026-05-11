import { z } from "zod";

/**
 * Zod schema for a single construction job.
 * Reused by analyze_jobs and variance_alerts.
 */
export const jobSchema = z.object({
  jobName: z
    .string()
    .min(1)
    .max(200)
    .describe("Human-readable job/project name. Used as the identifier across reports."),
  estimatedRevenue: z
    .number()
    .nonnegative("estimatedRevenue must be >= 0")
    .describe("Original quoted/budgeted revenue for the job, in dollars."),
  actualRevenue: z
    .number()
    .nonnegative("actualRevenue must be >= 0")
    .describe("Revenue invoiced or recognized to date, in dollars. Equals estimatedRevenue if not yet updated."),
  estimatedCosts: z
    .number()
    .nonnegative("estimatedCosts must be >= 0")
    .describe("Budgeted total costs for the job, in dollars."),
  actualCosts: z
    .number()
    .nonnegative("actualCosts must be >= 0")
    .describe("Actual costs incurred to date, in dollars."),
  status: z
    .string()
    .min(1)
    .describe(
      "Job status. Common values: estimating, active, complete, on_hold, cancelled. Free-form to accommodate external systems."
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be ISO YYYY-MM-DD")
    .describe("ISO YYYY-MM-DD start date."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be ISO YYYY-MM-DD")
    .nullable()
    .describe("ISO YYYY-MM-DD end date, or null if the job is still active."),
});

export type JobInput = z.infer<typeof jobSchema>;
