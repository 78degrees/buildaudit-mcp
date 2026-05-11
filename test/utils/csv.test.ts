import { describe, it, expect } from "vitest";
import {
  parseCsv,
  parseJobsCsv,
  parseExpensesCsv,
  coerceMoney,
  coerceBool,
  coerceDate,
} from "../../src/utils/csv.js";

describe("parseCsv — low-level tokenizer", () => {
  it("parses a simple CSV", () => {
    const rows = parseCsv("a,b,c\n1,2,3\n4,5,6");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("handles quoted fields with embedded commas", () => {
    const rows = parseCsv('vendor,desc\n"ABC, Inc.","hello, world"');
    expect(rows[1]).toEqual(["ABC, Inc.", "hello, world"]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    const rows = parseCsv('a\n"she said ""hi"""');
    expect(rows[1]).toEqual(['she said "hi"']);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("preserves empty cells", () => {
    const rows = parseCsv("a,b,c\n1,,3");
    expect(rows[1]).toEqual(["1", "", "3"]);
  });
});

describe("coerceMoney", () => {
  it.each([
    ["$1,234.56",  1234.56],
    ["1234.56",    1234.56],
    ["(5,000.00)", -5000],
    ["(5,000)",    -5000],
    ["-$50",       -50],
    ["0",          0],
    ["",           null],
    ["n/a",        null],
    ["—",          null],
  ])("coerceMoney(%s) → %s", (input, expected) => {
    expect(coerceMoney(input)).toBe(expected);
  });
});

describe("coerceBool", () => {
  it.each([
    ["true",  true],
    ["yes",   true],
    ["Y",     true],
    ["1",     true],
    ["false", false],
    ["no",    false],
    ["N",     false],
    ["0",     false],
    ["maybe", null],
    ["",      null],
  ])("coerceBool(%s) → %s", (input, expected) => {
    expect(coerceBool(input)).toBe(expected);
  });
});

describe("coerceDate", () => {
  it.each([
    ["2026-05-10",            "2026-05-10"],
    ["2026/05/10",            "2026-05-10"],
    ["5/10/2026",             "2026-05-10"],
    ["05/10/2026",            "2026-05-10"],
    ["5/10/26",               "2026-05-10"],
    ["2026-05-10T14:30:00Z",  "2026-05-10"],
    ["nonsense",              null],
    ["",                      null],
  ])("coerceDate(%s) → %s", (input, expected) => {
    expect(coerceDate(input)).toBe(expected);
  });
});

describe("parseJobsCsv — fuzzy headers", () => {
  it("maps 'Project' → jobName and parses currency-formatted columns", () => {
    // Currency values with embedded commas must be quoted in the CSV
    // (otherwise the comma is a field separator). Both forms exercised below.
    const csv = `Project,Contract Value,Actual Revenue,Estimate Cost,Spent,Status,Start,End
"Kitchen remodel - 123 Main","$80,000.00","$75,000.00","$60,000.00","$72,500.00",active,2026-01-15,2026-03-30
"Bathroom - 456 Oak",$40000,$40000,$30000,$28000,complete,2026-02-01,2026-02-28`;
    const jobs = parseJobsCsv(csv);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].jobName).toBe("Kitchen remodel - 123 Main");
    expect(jobs[0].estimatedRevenue).toBe(80000);
    expect(jobs[0].actualRevenue).toBe(75000);
    expect(jobs[0].estimatedCosts).toBe(60000);
    expect(jobs[0].actualCosts).toBe(72500);
    expect(jobs[0].status).toBe("active");
    expect(jobs[0].startDate).toBe("2026-01-15");
    expect(jobs[0].endDate).toBe("2026-03-30");
  });

  it("maps 'Work Order' synonym to jobName", () => {
    const csv = `Work Order,Estimated Revenue,Actual Revenue,Estimated Costs,Actual Costs,Status,Start Date,End Date
WO-42,10000,10000,5000,6000,active,2026-01-01,`;
    const jobs = parseJobsCsv(csv);
    expect(jobs[0].jobName).toBe("WO-42");
    expect(jobs[0].endDate).toBeNull();
  });

  it("skips rows with missing job name", () => {
    const csv = `Job Name,Estimated Revenue,Actual Revenue,Estimated Costs,Actual Costs,Status,Start Date,End Date
,10000,10000,5000,5000,active,2026-01-01,2026-02-01
Valid,20000,20000,10000,10000,active,2026-01-01,2026-02-01`;
    const jobs = parseJobsCsv(csv);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobName).toBe("Valid");
  });

  it("throws when no recognizable columns", () => {
    expect(() => parseJobsCsv("foo,bar,baz\n1,2,3")).toThrow(/No CSV columns matched/);
  });
});

describe("parseExpensesCsv — fuzzy headers", () => {
  it("maps 'Total' → amount, 'Supplier' → vendor, 'Memo' → description", () => {
    const csv = `Supplier,Total,Date,Job,PO Number,GL Code,Memo
"Home Depot","$453.21","5/3/2026","Kitchen remodel - 123 Main","PO-1001","02-100","Tile, grout, thinset"
"Ferguson","$1,200.00","2026-05-04","Kitchen remodel - 123 Main","","02-200","Bathroom fixtures"`;
    const expenses = parseExpensesCsv(csv);
    expect(expenses).toHaveLength(2);
    expect(expenses[0].vendor).toBe("Home Depot");
    expect(expenses[0].amount).toBe(453.21);
    expect(expenses[0].date).toBe("2026-05-03");
    expect(expenses[0].jobName).toBe("Kitchen remodel - 123 Main");
    expect(expenses[0].hasPurchaseOrder).toBe(true);     // "PO-1001" is non-empty
    expect(expenses[0].costCode).toBe("02-100");
    expect(expenses[1].hasPurchaseOrder).toBe(false);    // empty PO column
  });

  it("treats 'none' / 'n/a' in PO column as no PO", () => {
    const csv = `Vendor,Amount,Date,PO\nABC,100,2026-05-01,none\nDEF,200,2026-05-02,N/A`;
    const expenses = parseExpensesCsv(csv);
    expect(expenses[0].hasPurchaseOrder).toBe(false);
    expect(expenses[1].hasPurchaseOrder).toBe(false);
  });

  it("respects explicit boolean PO column", () => {
    const csv = `Vendor,Amount,Date,Has PO\nABC,100,2026-05-01,true\nDEF,200,2026-05-02,no`;
    const expenses = parseExpensesCsv(csv);
    expect(expenses[0].hasPurchaseOrder).toBe(true);
    expect(expenses[1].hasPurchaseOrder).toBe(false);
  });
});
