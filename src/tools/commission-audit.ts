/**
 * commission_audit — detect commission policy violations by comparing job
 * margins against a configurable floor, and flag same-week rate inconsistencies.
 *
 * For each job:
 *   profit  = actualRevenue - actualCosts
 *   margin  = profit / actualRevenue   (null when revenue is 0)
 *
 * A job is flagged when margin < margin_floor — commission should not have
 * been paid on that job.
 *
 * Commission exposure = actualRevenue * commission_rate for each flagged job.
 *
 * Same-week inconsistency: if two jobs that closed (endDate) in the same
 * ISO week have margins more than 20 percentage points apart, flag the pair.
 */

import type { CommissionAuditInput } from "../schemas/commission-audit.js";
import type { Job } from "../types/job.js";
import type { ToolResult } from "../server.js";
import { parseJobsCsv } from "../utils/csv.js";
import { formatCurrency, formatPercent } from "../utils/format.js";
import { InvalidInputError, toMcpError } from "../utils/errors.js";

export interface CommissionAuditEnv {}

interface FlaggedJob {
  jobName: string;
  margin: number | null;
  profit: number;
  actualRevenue: number;
  commissionPaid: number;
  status: string;
}

interface RateInconsistency {
  week: string;
  jobs: Array<{ jobName: string; margin: number }>;
  spread: number;
}

export async function handleCommissionAudit(
  input: CommissionAuditInput,
  _env: CommissionAuditEnv,
  _auth: unknown
): Promise<ToolResult> {
  try {
    const jobs = collectJobs(input);
    if (jobs.length === 0) {
      throw new InvalidInputError(
        "jobs",
        "At least one job is required (via `jobs` array or `csv_text`)."
      );
    }

    const marginFloor = input.margin_floor ?? 0.35;
    const commissionRate = input.commission_rate ?? 0.10;

    // 1. Per-job margin check
    const flaggedJobs: FlaggedJob[] = [];

    for (const j of jobs) {
      const profit = j.actualRevenue - j.actualCosts;
      const margin = j.actualRevenue > 0 ? profit / j.actualRevenue : null;

      if (margin === null || margin < marginFloor) {
        const commissionPaid = j.actualRevenue * commissionRate;
        flaggedJobs.push({
          jobName: j.jobName,
          margin: margin !== null ? round(margin, 6) : null,
          profit: round(profit, 2),
          actualRevenue: round(j.actualRevenue, 2),
          commissionPaid: round(commissionPaid, 2),
          status: j.status,
        });
      }
    }

    // 2. Total commission exposure on below-floor jobs
    const commissionExposure = flaggedJobs.reduce(
      (s, f) => s + f.commissionPaid,
      0
    );

    // 3. Worst offenders — top 10 by commission exposure
    const worstOffenders = [...flaggedJobs]
      .sort((a, b) => b.commissionPaid - a.commissionPaid)
      .slice(0, 10);

    // 4. Same-week rate inconsistencies (>20pp spread)
    const rateInconsistencies = detectWeeklyInconsistencies(jobs);

    // 5. Summary
    const summary = buildSummary({
      totalJobs: jobs.length,
      jobsBelowFloor: flaggedJobs.length,
      commissionExposure,
      marginFloor,
      commissionRate,
      inconsistencyCount: rateInconsistencies.length,
      worstJob: worstOffenders[0],
    });

    const result = {
      total_jobs: jobs.length,
      jobs_below_floor: flaggedJobs.length,
      commission_exposure: round(commissionExposure, 2),
      margin_floor_used: marginFloor,
      commission_rate_used: commissionRate,
      flagged_jobs: flaggedJobs,
      worst_offenders: worstOffenders,
      rate_inconsistencies: rateInconsistencies,
      summary,
    };

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return toMcpError(err) as ToolResult;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectJobs(input: CommissionAuditInput): Job[] {
  const fromArray = input.jobs ?? [];
  const fromCsv = input.csv_text ? parseJobsCsv(input.csv_text) : [];
  return [...fromArray, ...fromCsv];
}

/**
 * Get the ISO week key (YYYY-Wnn) for a date string.
 * Returns null if the date is missing or unparseable.
 */
function isoWeekKey(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;

  // ISO week algorithm: week 1 contains the first Thursday of the year.
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
  const isoStart = new Date(jan4.getTime());
  isoStart.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));

  const diff = d.getTime() - isoStart.getTime();
  const weekNum = Math.floor(diff / (7 * 86400000)) + 1;

  if (weekNum < 1) {
    // Falls in the last week of the previous year — close enough, use that key.
    return `${d.getUTCFullYear() - 1}-W53`;
  }

  return `${d.getUTCFullYear()}-W${weekNum < 10 ? "0" : ""}${weekNum}`;
}

/**
 * Detect same-week rate inconsistencies.
 * Groups jobs by ISO week of endDate. Within each week, if the margin
 * spread (max - min) exceeds 20 percentage points, flag the week.
 */
function detectWeeklyInconsistencies(jobs: Job[]): RateInconsistency[] {
  const SPREAD_THRESHOLD = 0.20; // 20 percentage points

  // Group by week using endDate
  const byWeek = new Map<string, Array<{ jobName: string; margin: number }>>();

  for (const j of jobs) {
    if (j.actualRevenue <= 0) continue;
    const profit = j.actualRevenue - j.actualCosts;
    const margin = profit / j.actualRevenue;
    const week = isoWeekKey(j.endDate);
    if (!week) continue;

    const entry = { jobName: j.jobName, margin: round(margin, 6) };
    const existing = byWeek.get(week);
    if (existing) {
      existing.push(entry);
    } else {
      byWeek.set(week, [entry]);
    }
  }

  const inconsistencies: RateInconsistency[] = [];

  for (const [week, weekJobs] of byWeek) {
    if (weekJobs.length < 2) continue;

    const margins = weekJobs.map((j) => j.margin);
    const min = Math.min(...margins);
    const max = Math.max(...margins);
    const spread = max - min;

    if (spread > SPREAD_THRESHOLD) {
      inconsistencies.push({
        week,
        jobs: weekJobs,
        spread: round(spread, 6),
      });
    }
  }

  return inconsistencies.sort((a, b) => b.spread - a.spread);
}

function buildSummary(p: {
  totalJobs: number;
  jobsBelowFloor: number;
  commissionExposure: number;
  marginFloor: number;
  commissionRate: number;
  inconsistencyCount: number;
  worstJob: FlaggedJob | undefined;
}): string {
  const parts: string[] = [];
  parts.push(
    `Audited ${p.totalJobs} job${p.totalJobs !== 1 ? "s" : ""} against a ${formatPercent(p.marginFloor)} margin floor ` +
      `at ${formatPercent(p.commissionRate)} commission rate.`
  );

  if (p.jobsBelowFloor === 0) {
    parts.push("No commission violations found — all jobs meet the margin floor.");
  } else {
    parts.push(
      `${p.jobsBelowFloor} job${p.jobsBelowFloor !== 1 ? "s" : ""} below the margin floor — ` +
        `total commission exposure ${formatCurrency(p.commissionExposure)}.`
    );
    if (p.worstJob) {
      parts.push(
        `Largest exposure: "${p.worstJob.jobName}" at ${formatCurrency(p.worstJob.commissionPaid)} ` +
          `(margin ${p.worstJob.margin !== null ? formatPercent(p.worstJob.margin) : "N/A"}).`
      );
    }
  }

  if (p.inconsistencyCount > 0) {
    parts.push(
      `${p.inconsistencyCount} same-week rate inconsistenc${p.inconsistencyCount !== 1 ? "ies" : "y"} detected (>20pp margin spread).`
    );
  }

  return parts.join(" ");
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
