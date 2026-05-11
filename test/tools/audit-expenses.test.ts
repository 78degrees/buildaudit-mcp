import { describe, it, expect } from "vitest";
import { handleAuditExpenses } from "../../src/tools/audit-expenses.js";
import type { Expense } from "../../src/types/expense.js";

function parse(result: { content: [{ type: string; text: string }]; isError?: boolean }) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const EXPENSES: Expense[] = [
  // Vendor concentration: Home Depot x3
  { vendor: "Home Depot",          amount: 453.21,  date: "2026-05-03", jobName: "Kitchen", hasPurchaseOrder: true,  costCode: "02-100", description: "Tile" },
  { vendor: "Home Depot",          amount: 89.99,   date: "2026-05-04", jobName: "Kitchen", hasPurchaseOrder: false, costCode: "02-100", description: "Caulk" },
  { vendor: "Home Depot",          amount: 3000.00, date: "2026-05-10", jobName: "Bathroom", hasPurchaseOrder: true,  costCode: "02-200", description: "Fixtures" },

  // No PO + no job assignment
  { vendor: "Random Vendor",       amount: 600,     date: "2026-05-08", jobName: null,      hasPurchaseOrder: false, costCode: null,    description: "Misc" },

  // Duplicate candidates: Ferguson @1200, two close dates
  { vendor: "Ferguson",            amount: 1200,    date: "2026-05-01", jobName: "Bathroom", hasPurchaseOrder: false, costCode: "02-200", description: "Plumbing" },
  { vendor: "Ferguson",            amount: 1200,    date: "2026-05-04", jobName: "Bathroom", hasPurchaseOrder: false, costCode: "02-200", description: "Plumbing again" },

  // Inconsistent cost code: 03-999 has multiple distinct vendors
  { vendor: "Vendor A", amount: 100, date: "2026-05-01", jobName: "Kitchen", hasPurchaseOrder: true,  costCode: "03-999", description: "x" },
  { vendor: "Vendor B", amount: 100, date: "2026-05-01", jobName: "Kitchen", hasPurchaseOrder: true,  costCode: "03-999", description: "y" },
  { vendor: "Vendor C", amount: 100, date: "2026-05-01", jobName: "Kitchen", hasPurchaseOrder: true,  costCode: "03-999", description: "z" },
  { vendor: "Vendor D", amount: 100, date: "2026-05-01", jobName: "Kitchen", hasPurchaseOrder: true,  costCode: "03-999", description: "w" },
];

describe("handleAuditExpenses", () => {
  it("sums unaudited spend (entries without PO)", async () => {
    const raw = await handleAuditExpenses({ expenses: EXPENSES }, {}, {});
    const r = parse(raw);
    // No-PO rows: 89.99 + 600 + 1200 + 1200 = 3089.99
    expect(r.total_unaudited_spend).toBeCloseTo(3089.99, 2);
    expect(r.unaudited_count).toBe(4);
  });

  it("rolls up expenses by vendor, sorted by total descending", async () => {
    const raw = await handleAuditExpenses({ expenses: EXPENSES }, {}, {});
    const r = parse(raw);
    const top = r.expenses_by_vendor[0];
    expect(top.vendor).toBe("Home Depot");
    expect(top.count).toBe(3);
    expect(top.total).toBeCloseTo(453.21 + 89.99 + 3000.00, 2);
  });

  it("flags unassigned expenses (no job linked)", async () => {
    const raw = await handleAuditExpenses({ expenses: EXPENSES }, {}, {});
    const r = parse(raw);
    expect(r.unassigned_expenses).toHaveLength(1);
    expect(r.unassigned_expenses[0].vendor).toBe("Random Vendor");
    expect(r.unassigned_total).toBe(600);
  });

  it("detects duplicates within the configured window", async () => {
    // Ferguson 1200 on 5/1 and 5/4 — within 7-day window → 1 duplicate group
    const raw = await handleAuditExpenses({ expenses: EXPENSES }, {}, {});
    const r = parse(raw);
    const fergusonDup = r.duplicates.find((d: any) => d.vendor === "Ferguson");
    expect(fergusonDup).toBeDefined();
    expect(fergusonDup.count).toBe(2);
    expect(fergusonDup.amount).toBe(1200);
  });

  it("respects duplicate_window_days override", async () => {
    // Make the window 2 days — Ferguson entries are 3 days apart, should NOT be flagged
    const raw = await handleAuditExpenses({ expenses: EXPENSES, duplicate_window_days: 2 }, {}, {});
    const r = parse(raw);
    expect(r.duplicates.find((d: any) => d.vendor === "Ferguson")).toBeUndefined();
  });

  it("flags cost codes with many distinct vendors as inconsistent", async () => {
    const raw = await handleAuditExpenses({ expenses: EXPENSES }, {}, {});
    const r = parse(raw);
    const code999 = r.cost_code_consistency.find((c: any) => c.cost_code === "03-999");
    expect(code999).toBeDefined();
    expect(code999.distinct_vendor_count).toBe(4);
    expect(code999.inconsistent).toBe(true);
  });

  it("works from csv_text", async () => {
    const csv = `Vendor,Total,Date,Job,PO,GL,Memo
Home Depot,$200,2026-05-01,Kitchen,yes,02-100,Lumber
Lowes,$150,2026-05-02,,no,02-100,Misc`;
    const raw = await handleAuditExpenses({ csv_text: csv }, {}, {});
    const r = parse(raw);
    expect(r.total_expenses).toBe(2);
    expect(r.unassigned_expenses).toHaveLength(1);
    expect(r.unassigned_expenses[0].vendor).toBe("Lowes");
  });

  it("returns INVALID_INPUT with neither expenses nor csv_text", async () => {
    const raw = await handleAuditExpenses({}, {}, {});
    expect(raw.isError).toBe(true);
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.error).toBe("INVALID_INPUT");
  });
});
