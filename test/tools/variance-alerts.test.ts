import { describe, it, expect } from "vitest";
import { handleVarianceAlerts } from "../../src/tools/variance-alerts.js";
import type { Job } from "../../src/types/job.js";

function parse(result: { content: [{ type: string; text: string }]; isError?: boolean }) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const JOBS: Job[] = [
  // Under budget — should NOT trigger
  { jobName: "Under",  estimatedRevenue: 100000, actualRevenue: 100000, estimatedCosts: 70000, actualCosts: 65000, status: "complete", startDate: "2026-01-01", endDate: "2026-02-01" },
  // 14% over — below default 25%
  { jobName: "Mild",   estimatedRevenue: 50000,  actualRevenue: 50000,  estimatedCosts: 40000, actualCosts: 45600, status: "complete", startDate: "2026-01-05", endDate: "2026-03-01" },
  // 50% over — flagged at default threshold
  { jobName: "Bad",    estimatedRevenue: 100000, actualRevenue: 100000, estimatedCosts: 60000, actualCosts: 90000, status: "active",   startDate: "2026-02-01", endDate: null },
  // 80% over — most severe
  { jobName: "Worst",  estimatedRevenue: 200000, actualRevenue: 200000, estimatedCosts: 100000, actualCosts: 180000, status: "active", startDate: "2026-03-01", endDate: null },
  // Zero estimate — should be skipped
  { jobName: "NoEst",  estimatedRevenue: 100000, actualRevenue: 100000, estimatedCosts: 0,     actualCosts: 50000, status: "active",   startDate: "2026-01-15", endDate: null },
];

describe("handleVarianceAlerts", () => {
  it("flags only jobs above the default 25% threshold", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS }, {}, {});
    const r = parse(raw);
    expect(r.flagged_count).toBe(2);
    expect(r.alerts.map((a: any) => a.jobName)).toEqual(["Worst", "Bad"]); // sorted by severity
  });

  it("computes correct variance_dollar and variance_percent", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS }, {}, {});
    const r = parse(raw);
    const bad = r.alerts.find((a: any) => a.jobName === "Bad");
    expect(bad.variance_dollar).toBe(30000);   // 90 - 60
    expect(bad.variance_percent).toBe(0.5);     // 50%
  });

  it("assigns severity_rank starting at 1", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS }, {}, {});
    const r = parse(raw);
    expect(r.alerts[0].severity_rank).toBe(1);
    expect(r.alerts[0].jobName).toBe("Worst");
    expect(r.alerts[1].severity_rank).toBe(2);
  });

  it("totals dollar overrun across flagged jobs", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS }, {}, {});
    const r = parse(raw);
    expect(r.total_overrun_dollars).toBe(30000 + 80000); // Bad + Worst
  });

  it("respects custom threshold_percent", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS, threshold_percent: 10 }, {}, {});
    const r = parse(raw);
    // Now Mild (14%), Bad (50%), Worst (80%) all flagged
    expect(r.flagged_count).toBe(3);
  });

  it("skips jobs with zero estimated costs", async () => {
    const raw = await handleVarianceAlerts({ jobs: JOBS }, {}, {});
    const r = parse(raw);
    expect(r.skipped_no_estimate).toContain("NoEst");
  });

  it("returns INVALID_INPUT when no jobs and no csv_text", async () => {
    const raw = await handleVarianceAlerts({}, {}, {});
    expect(raw.isError).toBe(true);
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.error).toBe("INVALID_INPUT");
  });
});
