/**
 * Domain type for a single expense line item.
 * Used by audit_expenses.
 */

export interface Expense {
  vendor: string;
  amount: number;
  date: string;              // ISO YYYY-MM-DD
  jobName: string | null;     // null/empty for unassigned
  hasPurchaseOrder: boolean;
  costCode: string | null;
  description: string;
}
