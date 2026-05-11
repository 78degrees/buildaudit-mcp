/**
 * audit_expenses — find unaudited spend, vendor concentration, unassigned
 * expenses, potential duplicates, and cost-code inconsistencies.
 */

import type { AuditExpensesInput } from "../schemas/audit-expenses.js";
import type { Expense } from "../types/expense.js";
import type { ToolResult } from "../server.js";
import { parseExpensesCsv } from "../utils/csv.js";
import { formatCurrency } from "../utils/format.js";
import { InvalidInputError, toMcpError } from "../utils/errors.js";

export interface AuditExpensesEnv {}

interface VendorRollup {
  vendor: string;
  total: number;
  count: number;
}

interface DuplicateGroup {
  vendor: string;
  amount: number;
  count: number;
  dates: string[];
  job_names: (string | null)[];
  descriptions: string[];
}

interface CostCodeRow {
  cost_code: string;
  distinct_vendor_count: number;
  sample_vendors: string[];
  total_amount: number;
  inconsistent: boolean;
}

export async function handleAuditExpenses(
  input: AuditExpensesInput,
  _env: AuditExpensesEnv,
  _auth: unknown
): Promise<ToolResult> {
  try {
    const expenses = collectExpenses(input);
    if (expenses.length === 0) {
      throw new InvalidInputError(
        "expenses",
        "At least one expense is required (via `expenses` array or `csv_text`)."
      );
    }

    const window = input.duplicate_window_days ?? 7;

    // 1. Unaudited spend (no PO)
    const unauditedRows = expenses.filter((e) => !e.hasPurchaseOrder);
    const total_unaudited_spend = unauditedRows.reduce((s, e) => s + e.amount, 0);

    // 2. Expenses by vendor (descending total)
    const byVendor = new Map<string, VendorRollup>();
    for (const e of expenses) {
      const key = e.vendor.trim();
      const cur = byVendor.get(key) ?? { vendor: key, total: 0, count: 0 };
      cur.total += e.amount;
      cur.count += 1;
      byVendor.set(key, cur);
    }
    const expenses_by_vendor = [...byVendor.values()]
      .map((v) => ({ vendor: v.vendor, total: round(v.total, 2), count: v.count }))
      .sort((a, b) => b.total - a.total);

    // 3. Unassigned expenses (no job linked)
    const unassigned = expenses.filter(
      (e) => !e.jobName || e.jobName.trim() === ""
    );
    const unassigned_expenses = unassigned.map((e) => ({
      vendor: e.vendor,
      amount: round(e.amount, 2),
      date: e.date,
      description: e.description,
      has_purchase_order: e.hasPurchaseOrder,
    }));
    const unassigned_total = unassigned.reduce((s, e) => s + e.amount, 0);

    // 4. Duplicate detection: same vendor (case-insensitive) + same amount + |date diff| <= window
    const duplicates = findDuplicates(expenses, window);

    // 5. Cost-code consistency: same code → expect same vendor pattern; flag mismatches
    const cost_code_consistency = analyzeCostCodes(expenses);

    // 6. Summary
    const summary = buildSummary({
      count: expenses.length,
      total_unaudited_spend,
      unaudited_count: unauditedRows.length,
      unassigned_count: unassigned.length,
      unassigned_total,
      duplicate_groups: duplicates.length,
      inconsistent_codes: cost_code_consistency.filter((c) => c.inconsistent).length,
    });

    const result = {
      total_expenses: expenses.length,
      total_unaudited_spend: round(total_unaudited_spend, 2),
      unaudited_count: unauditedRows.length,
      expenses_by_vendor,
      unassigned_expenses,
      unassigned_total: round(unassigned_total, 2),
      duplicates,
      duplicate_window_days: window,
      cost_code_consistency,
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

function collectExpenses(input: AuditExpensesInput): Expense[] {
  const fromArray = input.expenses ?? [];
  const fromCsv = input.csv_text ? parseExpensesCsv(input.csv_text) : [];
  return [...fromArray, ...fromCsv];
}

function findDuplicates(expenses: Expense[], windowDays: number): DuplicateGroup[] {
  // Group by (normalized vendor, exact amount). Then within each group, find
  // any pair of entries whose date diff is ≤ window. We collapse all such
  // overlapping entries into one group for the response.
  const byKey = new Map<string, Expense[]>();
  for (const e of expenses) {
    const key = `${e.vendor.trim().toLowerCase()}|${e.amount.toFixed(2)}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const out: DuplicateGroup[] = [];
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => a.date.localeCompare(b.date));
    // Sweep — combine entries that fall within `windowDays` of any other entry
    // already in the running cluster.
    let cluster: Expense[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1];
      if (daysBetween(prev.date, sorted[i].date) <= windowDays) {
        cluster.push(sorted[i]);
      } else {
        if (cluster.length >= 2) out.push(clusterToGroup(cluster));
        cluster = [sorted[i]];
      }
    }
    if (cluster.length >= 2) out.push(clusterToGroup(cluster));
  }

  return out.sort((a, b) => b.count - a.count || b.amount - a.amount);
}

function clusterToGroup(cluster: Expense[]): DuplicateGroup {
  return {
    vendor:        cluster[0].vendor,
    amount:        round(cluster[0].amount, 2),
    count:         cluster.length,
    dates:         cluster.map((e) => e.date),
    job_names:     cluster.map((e) => e.jobName),
    descriptions:  cluster.map((e) => e.description),
  };
}

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA + "T00:00:00Z");
  const b = Date.parse(isoB + "T00:00:00Z");
  if (!isFinite(a) || !isFinite(b)) return Infinity;
  return Math.abs((b - a) / 86_400_000);
}

function analyzeCostCodes(expenses: Expense[]): CostCodeRow[] {
  const byCode = new Map<string, { vendors: Set<string>; total: number; samples: Set<string> }>();
  for (const e of expenses) {
    const code = (e.costCode ?? "").trim();
    if (!code) continue;
    const v = byCode.get(code) ?? { vendors: new Set<string>(), total: 0, samples: new Set<string>() };
    v.vendors.add(e.vendor.trim());
    v.total += e.amount;
    if (v.samples.size < 5) v.samples.add(e.vendor.trim());
    byCode.set(code, v);
  }

  const rows: CostCodeRow[] = [];
  for (const [code, info] of byCode) {
    rows.push({
      cost_code:              code,
      distinct_vendor_count:  info.vendors.size,
      sample_vendors:         [...info.samples].slice(0, 5),
      total_amount:           round(info.total, 2),
      // Heuristic: more than 3 distinct vendors under one code suggests
      // a catch-all or miscategorisation. Tweakable later.
      inconsistent:           info.vendors.size > 3,
    });
  }
  return rows.sort((a, b) => b.total_amount - a.total_amount);
}

function buildSummary(p: {
  count: number;
  total_unaudited_spend: number;
  unaudited_count: number;
  unassigned_count: number;
  unassigned_total: number;
  duplicate_groups: number;
  inconsistent_codes: number;
}): string {
  const parts: string[] = [];
  parts.push(`Audited ${p.count} expense${p.count !== 1 ? "s" : ""}.`);
  if (p.unaudited_count > 0) {
    parts.push(
      `${p.unaudited_count} have no PO — ${formatCurrency(p.total_unaudited_spend)} of unaudited spend.`
    );
  }
  if (p.unassigned_count > 0) {
    parts.push(
      `${p.unassigned_count} not assigned to any job (${formatCurrency(p.unassigned_total)}).`
    );
  }
  if (p.duplicate_groups > 0) {
    parts.push(`${p.duplicate_groups} possible duplicate group${p.duplicate_groups !== 1 ? "s" : ""}.`);
  }
  if (p.inconsistent_codes > 0) {
    parts.push(`${p.inconsistent_codes} cost code${p.inconsistent_codes !== 1 ? "s" : ""} look inconsistent (many vendors under one code).`);
  }
  if (parts.length === 1) {
    parts.push("No issues flagged.");
  }
  return parts.join(" ");
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
