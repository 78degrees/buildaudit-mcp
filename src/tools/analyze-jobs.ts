/**
 * analyze_jobs — profitability ranking, jobs losing money, margin distribution,
 * and total exposure on underwater jobs.
 *
 * Profit per job:   actualRevenue - actualCosts
 * Margin per job:   profit / actualRevenue   (null when revenue is 0)
 */

import type { AnalyzeJobsInput } from "../schemas/analyze-jobs.js";
import type { Job } from "../types/job.js";
import type { ToolResult } from "../server.js";
import { parseJobsCsv } from "../utils/csv.js";
import { formatCurrency, formatPercent } from "../utils/format.js";
import { InvalidInputError, toMcpError } from "../utils/errors.js";

export interface AnalyzeJobsEnv {
  // No external bindings needed yet — kept for shape parity with QuantRisk.
}

interface JobAnalysis {
  jobName: string;
  status: string;
  profit: number;
  margin: number | null;
  estimatedRevenue: number;
  actualRevenue: number;
  estimatedCosts: number;
  actualCosts: number;
}

export async function handleAnalyzeJobs(
  input: AnalyzeJobsInput,
  _env: AnalyzeJobsEnv,
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

    // 1. Per-job analysis
    const analyses: JobAnalysis[] = jobs.map((j) => {
      const profit = j.actualRevenue - j.actualCosts;
      const margin = j.actualRevenue > 0 ? profit / j.actualRevenue : null;
      return {
        jobName:           j.jobName,
        status:            j.status,
        profit,
        margin,
        estimatedRevenue:  j.estimatedRevenue,
        actualRevenue:     j.actualRevenue,
        estimatedCosts:    j.estimatedCosts,
        actualCosts:       j.actualCosts,
      };
    });

    // 2. Profitability ranking (descending profit)
    const profitability_ranking = [...analyses].sort((a, b) => b.profit - a.profit);

    // 3. Jobs losing money
    const jobs_losing_money = analyses.filter((a) => a.profit < 0);

    // 4. Average margin (excludes jobs with null margin / zero revenue)
    const validMargins = analyses
      .map((a) => a.margin)
      .filter((m): m is number => m !== null && isFinite(m));
    const average_margin =
      validMargins.length > 0
        ? validMargins.reduce((s, x) => s + x, 0) / validMargins.length
        : null;

    // 5. Margin distribution — percentiles + count
    const margin_distribution = describeDistribution(validMargins);

    // 6. Total exposure on underwater jobs (sum of |losses|)
    const total_exposure_underwater = jobs_losing_money.reduce(
      (s, j) => s + Math.abs(j.profit),
      0
    );

    // 7. Summary prose
    const summary = buildSummary({
      count_total: jobs.length,
      count_underwater: jobs_losing_money.length,
      total_exposure_underwater,
      average_margin,
      best: profitability_ranking[0],
      worst: profitability_ranking[profitability_ranking.length - 1],
    });

    const result = {
      count_total: jobs.length,
      count_underwater: jobs_losing_money.length,
      profitability_ranking: profitability_ranking.map(roundJobAnalysis),
      jobs_losing_money: jobs_losing_money.map(roundJobAnalysis),
      average_margin: average_margin !== null ? round(average_margin, 6) : null,
      margin_distribution,
      total_exposure_underwater: round(total_exposure_underwater, 2),
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

function collectJobs(input: AnalyzeJobsInput): Job[] {
  const fromArray = input.jobs ?? [];
  const fromCsv = input.csv_text ? parseJobsCsv(input.csv_text) : [];
  return [...fromArray, ...fromCsv];
}

function describeDistribution(values: number[]): {
  count: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
} {
  if (values.length === 0) {
    return { count: 0, min: null, p10: null, p25: null, p50: null, p75: null, p90: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return round(sorted[idx], 6);
  };
  return {
    count: sorted.length,
    min: round(sorted[0], 6),
    p10: pct(10),
    p25: pct(25),
    p50: pct(50),
    p75: pct(75),
    p90: pct(90),
    max: round(sorted[sorted.length - 1], 6),
  };
}

function buildSummary(p: {
  count_total: number;
  count_underwater: number;
  total_exposure_underwater: number;
  average_margin: number | null;
  best: JobAnalysis | undefined;
  worst: JobAnalysis | undefined;
}): string {
  const parts: string[] = [];
  parts.push(`Analyzed ${p.count_total} job${p.count_total !== 1 ? "s" : ""}.`);
  if (p.average_margin !== null) {
    parts.push(`Average margin: ${formatPercent(p.average_margin)}.`);
  }
  if (p.count_underwater > 0) {
    parts.push(
      `${p.count_underwater} job${p.count_underwater !== 1 ? "s" : ""} losing money — ` +
        `total exposure ${formatCurrency(p.total_exposure_underwater)}.`
    );
  } else {
    parts.push("No jobs underwater.");
  }
  if (p.best && p.worst && p.best !== p.worst) {
    parts.push(
      `Most profitable: "${p.best.jobName}" (${formatCurrency(p.best.profit)}). ` +
        `Worst: "${p.worst.jobName}" (${formatCurrency(p.worst.profit)}).`
    );
  }
  return parts.join(" ");
}

function roundJobAnalysis(j: JobAnalysis): JobAnalysis {
  return {
    ...j,
    profit:           round(j.profit, 2),
    margin:           j.margin !== null ? round(j.margin, 6) : null,
    estimatedRevenue: round(j.estimatedRevenue, 2),
    actualRevenue:    round(j.actualRevenue, 2),
    estimatedCosts:   round(j.estimatedCosts, 2),
    actualCosts:      round(j.actualCosts, 2),
  };
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
