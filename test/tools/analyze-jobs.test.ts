import { describe, it, expect } from "vitest";
import { handleAnalyzeJobs } from "../../src/tools/analyze-jobs.js";
import type { Job } from "../../src/types/job.js";

function parse(result: { content: [{ type: string; text: string }]; isError?: boolean }) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const FIXTURE: Job[] = [
  // Profitable
  { jobName: "A", estimatedRevenue: 100000, actualRevenue: 100000, estimatedCosts: 70000, actualCosts: 60000, status: "complete", startDate: "2026-01-01", endDate: "2026-02-01" },
  // Losing money
  { jobName: "B", estimatedRevenue: 50000,  actualRevenue: 50000,  estimatedCosts: 40000, actualCosts: 60000, status: "complete", startDate: "2026-01-05", endDate: "2026-03-01" },
  // Break-even ish
  { jobName: "C", estimatedRevenue: 30000,  actualRevenue: 30000,  estimatedCosts: 28000, actualCosts: 29500, status: "complete", startDate: "2026-02-01", endDate: "2026-02-15" },
  // Bigger loser
  { jobName: "D", estimatedRevenue: 200000, actualRevenue: 180000, estimatedCosts: 150000, actualCosts: 230000, status: "active", startDate: "2026-03-01", endDate: null },
];

describe("handleAnalyzeJobs", () => {
  it("computes profitability ranking and identifies underwater jobs", async () => {
    const raw = await handleAnalyzeJobs({ jobs: FIXTURE }, {}, {});
    const r = parse(raw);

    expect(r.count_total).toBe(4);
    expect(r.count_underwater).toBe(2);

    // A (+40k) > C (+0.5k) > B (-10k) > D (-50k)
    expect(r.profitability_ranking.map((j: any) => j.jobName)).toEqual(["A", "C", "B", "D"]);

    // jobs_losing_money sorted by descending profit (so B before D)
    expect(r.jobs_losing_money.map((j: any) => j.jobName)).toEqual(["B", "D"]);
    expect(r.total_exposure_underwater).toBe(60000); // |−10k| + |−50k|
  });

  it("computes average margin across jobs with positive revenue", async () => {
    const raw = await handleAnalyzeJobs({ jobs: FIXTURE }, {}, {});
    const r = parse(raw);
    // Margins: A: 0.4, B: -0.2, C: 0.01667, D: -0.27778
    const expected = (0.4 + -0.2 + (500 / 30000) + (-50000 / 180000)) / 4;
    expect(r.average_margin).toBeCloseTo(expected, 4);
  });

  it("returns full margin distribution (count + percentiles)", async () => {
    const raw = await handleAnalyzeJobs({ jobs: FIXTURE }, {}, {});
    const r = parse(raw);
    expect(r.margin_distribution.count).toBe(4);
    expect(r.margin_distribution.min).toBeLessThanOrEqual(r.margin_distribution.p50);
    expect(r.margin_distribution.p50).toBeLessThanOrEqual(r.margin_distribution.max);
  });

  it("returns INVALID_INPUT when no jobs and no csv_text", async () => {
    const raw = await handleAnalyzeJobs({}, {}, {});
    expect(raw.isError).toBe(true);
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.error).toBe("INVALID_INPUT");
  });

  it("works when jobs arrive via csv_text", async () => {
    // Kitchen: actRev 90k − actCost 100k = −10k (loser)
    // Bathroom: actRev 40k − actCost 25k = +15k
    const csv = `Project,Estimated Revenue,Actual Revenue,Estimated Costs,Actual Costs,Status,Start,End
Kitchen,100000,90000,70000,100000,active,2026-01-01,
Bathroom,40000,40000,30000,25000,complete,2026-02-01,2026-02-28`;
    const raw = await handleAnalyzeJobs({ csv_text: csv }, {}, {});
    const r = parse(raw);
    expect(r.count_total).toBe(2);
    expect(r.count_underwater).toBe(1);
  });

  it("summary mentions exposure when there are underwater jobs", async () => {
    const raw = await handleAnalyzeJobs({ jobs: FIXTURE }, {}, {});
    const r = parse(raw);
    expect(r.summary).toMatch(/losing money/);
    expect(r.summary).toMatch(/exposure/);
  });
});
