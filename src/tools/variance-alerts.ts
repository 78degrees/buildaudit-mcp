/**
 * variance_alerts — flag jobs whose cost overrun exceeds `threshold_percent`.
 *
 * Variance per job:
 *   variance_dollar  = actualCosts - estimatedCosts
 *   variance_percent = variance_dollar / estimatedCosts          (skipped if estimatedCosts <= 0)
 *
 * Returns alerts sorted by descending variance_percent (most severe first).
 */

import type { VarianceAlertsInput } from "../schemas/variance-alerts.js";
import type { Job } from "../types/job.js";
import type { ToolResult } from "../server.js";
import { parseJobsCsv } from "../utils/csv.js";
import { formatCurrency, formatPercent } from "../utils/format.js";
import { InvalidInputError, toMcpError } from "../utils/errors.js";

export interface VarianceAlertsEnv {}

interface VarianceAlert {
  jobName: string;
  status: string;
  estimated_costs: number;
  actual_costs: number;
  variance_dollar: number;
  variance_percent: number;
  severity_rank: number;
}

export async function handleVarianceAlerts(
  input: VarianceAlertsInput,
  _env: VarianceAlertsEnv,
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

    const thresholdPct = input.threshold_percent ?? 25;
    const thresholdFraction = thresholdPct / 100;

    const skipped_no_estimate: string[] = [];
    const candidates: Array<Omit<VarianceAlert, "severity_rank">> = [];

    for (const j of jobs) {
      if (j.estimatedCosts <= 0) {
        skipped_no_estimate.push(j.jobName);
        continue;
      }
      const variance_dollar  = j.actualCosts - j.estimatedCosts;
      const variance_percent = variance_dollar / j.estimatedCosts;

      if (variance_percent > thresholdFraction) {
        candidates.push({
          jobName:          j.jobName,
          status:           j.status,
          estimated_costs:  round(j.estimatedCosts, 2),
          actual_costs:     round(j.actualCosts, 2),
          variance_dollar:  round(variance_dollar, 2),
          variance_percent: round(variance_percent, 6),
        });
      }
    }

    // Sort by severity (highest overrun %) and assign rank
    const alerts: VarianceAlert[] = candidates
      .sort((a, b) => b.variance_percent - a.variance_percent)
      .map((c, idx) => ({ ...c, severity_rank: idx + 1 }));

    const total_overrun = alerts.reduce((s, a) => s + a.variance_dollar, 0);

    const summary = buildSummary({
      jobs_checked: jobs.length,
      threshold_pct: thresholdPct,
      flagged: alerts.length,
      total_overrun,
      skipped_count: skipped_no_estimate.length,
      worst: alerts[0],
    });

    const result = {
      jobs_checked: jobs.length,
      threshold_percent: thresholdPct,
      flagged_count: alerts.length,
      total_overrun_dollars: round(total_overrun, 2),
      alerts,
      skipped_no_estimate,
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

function collectJobs(input: VarianceAlertsInput): Job[] {
  const fromArray = input.jobs ?? [];
  const fromCsv = input.csv_text ? parseJobsCsv(input.csv_text) : [];
  return [...fromArray, ...fromCsv];
}

function buildSummary(p: {
  jobs_checked: number;
  threshold_pct: number;
  flagged: number;
  total_overrun: number;
  skipped_count: number;
  worst: VarianceAlert | undefined;
}): string {
  const parts: string[] = [];
  parts.push(
    `Checked ${p.jobs_checked} job${p.jobs_checked !== 1 ? "s" : ""} against a ${p.threshold_pct}% cost-overrun threshold.`
  );
  if (p.flagged === 0) {
    parts.push("No jobs flagged.");
  } else {
    parts.push(
      `${p.flagged} job${p.flagged !== 1 ? "s" : ""} over budget by more than ${p.threshold_pct}% — ` +
        `total overrun ${formatCurrency(p.total_overrun)}.`
    );
    if (p.worst) {
      parts.push(
        `Worst: "${p.worst.jobName}" at ${formatPercent(p.worst.variance_percent)} over (${formatCurrency(p.worst.variance_dollar)}).`
      );
    }
  }
  if (p.skipped_count > 0) {
    parts.push(`${p.skipped_count} job${p.skipped_count !== 1 ? "s" : ""} skipped (no cost estimate).`);
  }
  return parts.join(" ");
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
