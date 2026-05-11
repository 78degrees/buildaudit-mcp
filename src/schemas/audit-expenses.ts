import { z } from "zod";
import { expenseSchema } from "./expense.js";

/**
 * Input schema for audit_expenses.
 *
 * Either `expenses` (structured array) or `csv_text` (raw CSV with fuzzy
 * headers) must be provided.
 */
export const auditExpensesSchema = z.object({
  expenses: z
    .array(expenseSchema)
    .optional()
    .describe("Array of structured expense objects. Optional if csv_text is provided."),
  csv_text: z
    .string()
    .optional()
    .describe(
      "Raw CSV text. Headers are fuzzy-matched to the Expense schema — e.g., 'Total', 'Cost', 'Price' all map to amount."
    ),
  duplicate_window_days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe("Window (in days) within which same-vendor + same-amount expenses are flagged as potential duplicates."),
});

export type AuditExpensesInput = z.infer<typeof auditExpensesSchema>;
