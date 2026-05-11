import { z } from "zod";

/**
 * Zod schema for a single expense line item.
 * Used by audit_expenses.
 */
export const expenseSchema = z.object({
  vendor: z
    .string()
    .min(1)
    .max(200)
    .describe("Name of the vendor/supplier (e.g., 'Home Depot', 'Ferguson Plumbing Supply')."),
  amount: z
    .number()
    .describe("Expense amount in dollars. Negative values are allowed (refunds, returns)."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD")
    .describe("ISO YYYY-MM-DD date the expense was incurred."),
  jobName: z
    .string()
    .nullable()
    .describe("Name of the job/project this expense was charged to. Null or empty string means unassigned."),
  hasPurchaseOrder: z
    .boolean()
    .describe("Whether this expense has a corresponding purchase order on file."),
  costCode: z
    .string()
    .nullable()
    .describe("Cost code / GL account (e.g., '02-100 Demolition'). Null if uncategorized."),
  description: z
    .string()
    .describe("Free-text description from the receipt or vendor invoice."),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;
