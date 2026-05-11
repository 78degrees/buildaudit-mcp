/**
 * cash_flow — Project cash flow over a forecast period based on active jobs.
 *
 * Builds a weekly timeline of inflows (revenue collections) and outflows
 * (remaining costs), tracks running balance, and flags when cash goes negative.
 *
 * Completion %:      actualCosts / estimatedCosts  (capped at 1.0)
 * Remaining revenue: estimatedRevenue - actualRevenue
 * Remaining costs:   estimatedCosts - actualCosts   (floored at 0)
 */

import type { CashFlowInput } from "../schemas/cash-flow.js";
import type { Job } from "../types/job.js";
import type { ToolResult } from "../server.js";
import { parseJobsCsv } from "../utils/csv.js";
import { formatCurrency } from "../utils/format.js";
import { InvalidInputError, toMcpError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleCashFlow(
  input: CashFlowInput,
  _env: unknown,
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

    const startingBalance  = input.starting_balance ?? 0;
    const forecastDays     = input.forecast_days ?? 90;
    const collectionLag    = input.collection_lag_days ?? 30;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const forecastEnd = new Date(today);
    forecastEnd.setDate(forecastEnd.getDate() + forecastDays);

    // ----- Per-job projections -----
    const jobProjections = jobs
      .filter((j) => isActiveJob(j))
      .map((j) => projectJob(j, today, forecastEnd, collectionLag));

    // ----- Build weekly buckets -----
    const weeks = buildWeeklyBuckets(today, forecastEnd);

    // Distribute each job's projected inflows and outflows into weekly buckets
    for (const proj of jobProjections) {
      for (const flow of proj.weeklyInflows) {
        addToWeek(weeks, flow.date, "inflows", flow.amount);
      }
      for (const flow of proj.weeklyOutflows) {
        addToWeek(weeks, flow.date, "outflows", flow.amount);
      }
    }

    // Compute net and running balance
    let runningBalance = startingBalance;
    let lowestBalance = startingBalance;
    let peakBalance = startingBalance;
    let daysUntilNegative: number | null = null;

    for (const week of weeks) {
      week.net = round(week.inflows - week.outflows, 2);
      runningBalance = round(runningBalance + week.net, 2);
      week.running_balance = runningBalance;

      if (runningBalance < lowestBalance) {
        lowestBalance = runningBalance;
      }
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      if (daysUntilNegative === null && runningBalance < 0) {
        const weekDate = new Date(week.week);
        daysUntilNegative = Math.max(
          0,
          Math.floor((weekDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        );
      }
    }

    const totalProjectedInflows = round(
      weeks.reduce((s, w) => s + w.inflows, 0),
      2
    );
    const totalProjectedOutflows = round(
      weeks.reduce((s, w) => s + w.outflows, 0),
      2
    );
    const netCashFlow = round(totalProjectedInflows - totalProjectedOutflows, 2);

    // ----- Per-job summary -----
    const jobSummaries = jobProjections.map((p) => ({
      jobName:           p.jobName,
      completion_pct:    round(p.completionPct, 4),
      remaining_revenue: round(p.remainingRevenue, 2),
      remaining_costs:   round(p.remainingCosts, 2),
      remaining_days:    p.remainingDays,
    }));

    // ----- Summary prose -----
    const summary = buildSummary({
      jobCount: jobProjections.length,
      totalActiveJobs: jobs.filter(isActiveJob).length,
      totalJobs: jobs.length,
      startingBalance,
      forecastDays,
      collectionLag,
      totalProjectedInflows,
      totalProjectedOutflows,
      netCashFlow,
      lowestBalance,
      peakBalance,
      daysUntilNegative,
    });

    const result = {
      starting_balance: startingBalance,
      forecast_days: forecastDays,
      collection_lag_days: collectionLag,
      active_jobs_count: jobProjections.length,
      total_projected_inflows: totalProjectedInflows,
      total_projected_outflows: totalProjectedOutflows,
      net_cash_flow: netCashFlow,
      lowest_balance: round(lowestBalance, 2),
      peak_balance: round(peakBalance, 2),
      days_until_negative: daysUntilNegative,
      weekly_timeline: weeks.map((w) => ({
        week:            w.week,
        inflows:         round(w.inflows, 2),
        outflows:        round(w.outflows, 2),
        net:             round(w.net, 2),
        running_balance: round(w.running_balance, 2),
      })),
      job_summaries: jobSummaries,
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

function collectJobs(input: CashFlowInput): Job[] {
  const fromArray = input.jobs ?? [];
  const fromCsv = input.csv_text ? parseJobsCsv(input.csv_text) : [];
  return [...fromArray, ...fromCsv];
}

function isActiveJob(job: Job): boolean {
  const s = job.status.toLowerCase();
  return s === "active" || s === "in_progress" || s === "in progress";
}

interface DatedAmount {
  date: Date;
  amount: number;
}

interface JobProjection {
  jobName: string;
  completionPct: number;
  remainingRevenue: number;
  remainingCosts: number;
  remainingDays: number;
  weeklyInflows: DatedAmount[];
  weeklyOutflows: DatedAmount[];
}

function projectJob(
  job: Job,
  today: Date,
  forecastEnd: Date,
  collectionLagDays: number
): JobProjection {
  // Completion percentage based on costs incurred vs estimated
  const completionPct =
    job.estimatedCosts > 0
      ? Math.min(1.0, job.actualCosts / job.estimatedCosts)
      : 1.0;

  const remainingRevenue = Math.max(0, job.estimatedRevenue - job.actualRevenue);
  const remainingCosts = Math.max(0, job.estimatedCosts - job.actualCosts);

  // Determine remaining days for cost spread
  let remainingDays: number;
  if (job.endDate) {
    const endDate = new Date(job.endDate);
    endDate.setHours(0, 0, 0, 0);
    remainingDays = Math.max(
      1,
      Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    );
  } else {
    remainingDays = 90;
  }

  // Cap remaining days to forecast period
  const effectiveDays = Math.min(
    remainingDays,
    Math.ceil((forecastEnd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  );

  // Spread costs evenly: daily cost rate over remaining duration
  const dailyCostRate = effectiveDays > 0 ? remainingCosts / remainingDays : 0;

  // Revenue arrives after collection lag — spread evenly over remaining duration,
  // then delay each chunk by collection_lag_days
  const dailyRevenueRate = remainingDays > 0 ? remainingRevenue / remainingDays : 0;

  // Generate daily flows and bucket into weekly arrays
  const weeklyInflows: DatedAmount[] = [];
  const weeklyOutflows: DatedAmount[] = [];

  for (let d = 0; d < effectiveDays; d++) {
    // Outflows: costs hit on the day they're incurred
    if (dailyCostRate > 0) {
      const costDate = new Date(today);
      costDate.setDate(costDate.getDate() + d);
      if (costDate <= forecastEnd) {
        weeklyOutflows.push({ date: costDate, amount: dailyCostRate });
      }
    }

    // Inflows: revenue is earned on day d, but collected after lag
    if (dailyRevenueRate > 0) {
      const collectDate = new Date(today);
      collectDate.setDate(collectDate.getDate() + d + collectionLagDays);
      if (collectDate <= forecastEnd) {
        weeklyInflows.push({ date: collectDate, amount: dailyRevenueRate });
      }
    }
  }

  return {
    jobName: job.jobName,
    completionPct,
    remainingRevenue,
    remainingCosts,
    remainingDays,
    weeklyInflows,
    weeklyOutflows,
  };
}

interface WeekBucket {
  week: string; // ISO date of Monday
  inflows: number;
  outflows: number;
  net: number;
  running_balance: number;
}

function buildWeeklyBuckets(start: Date, end: Date): WeekBucket[] {
  const buckets: WeekBucket[] = [];

  // Find the Monday on or before start
  const monday = new Date(start);
  const dayOfWeek = monday.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(monday.getDate() - daysToMonday);

  const cursor = new Date(monday);
  while (cursor <= end) {
    buckets.push({
      week: toISODate(cursor),
      inflows: 0,
      outflows: 0,
      net: 0,
      running_balance: 0,
    });
    cursor.setDate(cursor.getDate() + 7);
  }

  return buckets;
}

function addToWeek(
  weeks: WeekBucket[],
  date: Date,
  field: "inflows" | "outflows",
  amount: number
): void {
  // Find the week bucket this date falls into
  // The week bucket is the Monday on or before the date
  const dayOfWeek = date.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(date);
  monday.setDate(monday.getDate() - daysToMonday);
  const key = toISODate(monday);

  const bucket = weeks.find((w) => w.week === key);
  if (bucket) {
    bucket[field] += amount;
  }
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildSummary(p: {
  jobCount: number;
  totalActiveJobs: number;
  totalJobs: number;
  startingBalance: number;
  forecastDays: number;
  collectionLag: number;
  totalProjectedInflows: number;
  totalProjectedOutflows: number;
  netCashFlow: number;
  lowestBalance: number;
  peakBalance: number;
  daysUntilNegative: number | null;
}): string {
  const parts: string[] = [];

  parts.push(
    `Cash flow forecast for ${p.jobCount} active job${p.jobCount !== 1 ? "s" : ""} ` +
      `(of ${p.totalJobs} total) over the next ${p.forecastDays} days.`
  );

  parts.push(
    `Starting balance: ${formatCurrency(p.startingBalance)}. ` +
      `Collection lag: ${p.collectionLag} days.`
  );

  parts.push(
    `Projected inflows: ${formatCurrency(p.totalProjectedInflows)}. ` +
      `Projected outflows: ${formatCurrency(p.totalProjectedOutflows)}. ` +
      `Net: ${formatCurrency(p.netCashFlow)}.`
  );

  if (p.daysUntilNegative !== null) {
    parts.push(
      `WARNING: Cash goes negative in ~${p.daysUntilNegative} day${p.daysUntilNegative !== 1 ? "s" : ""}. ` +
        `Lowest projected balance: ${formatCurrency(p.lowestBalance)}.`
    );
  } else {
    parts.push(
      `Cash stays positive throughout the forecast. ` +
        `Lowest balance: ${formatCurrency(p.lowestBalance)}. ` +
        `Peak: ${formatCurrency(p.peakBalance)}.`
    );
  }

  return parts.join(" ");
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
