/**
 * Domain type for a construction job / project.
 * Shared between analyze_jobs and variance_alerts tools.
 */

export type JobStatus =
  | "estimating"
  | "active"
  | "complete"
  | "cancelled"
  | "on_hold"
  | string;

export interface Job {
  jobName: string;
  estimatedRevenue: number;
  actualRevenue: number;
  estimatedCosts: number;
  actualCosts: number;
  status: JobStatus;
  startDate: string;        // ISO YYYY-MM-DD
  endDate: string | null;    // null for still-active jobs
}
