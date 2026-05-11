/**
 * server.ts — MCP server factory for BuildAudit.
 *
 * Each tool is wrapped in an auth middleware closure that captures the raw
 * HTTP request (the MCP SDK's RequestHandlerExtra doesn't expose it).
 *
 * Pipeline per tool call:  auth → handler
 *
 * Tier-gate and rate-limit middleware are intentionally not present yet —
 * they'll be added when we wire up paid tier behavior.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { analyzeJobsSchema }      from "./schemas/analyze-jobs.js";
import { auditExpensesSchema }    from "./schemas/audit-expenses.js";
import { varianceAlertsSchema }   from "./schemas/variance-alerts.js";
import { commissionAuditSchema }  from "./schemas/commission-audit.js";
import { cashFlowSchema }         from "./schemas/cash-flow.js";
import { quickbooksSyncSchema }   from "./schemas/quickbooks-sync.js";

import { handleAnalyzeJobs }      from "./tools/analyze-jobs.js";
import { handleAuditExpenses }    from "./tools/audit-expenses.js";
import { handleVarianceAlerts }   from "./tools/variance-alerts.js";
import { handleCommissionAudit }  from "./tools/commission-audit.js";
import { handleCashFlow }         from "./tools/cash-flow.js";
import { handleQuickBooksSync }   from "./tools/quickbooks-sync.js";

import { authenticateRequest }    from "./middleware/auth.js";
import { toMcpError }             from "./utils/errors.js";

// ---------------------------------------------------------------------------
// Env interface — full set of Worker bindings
// ---------------------------------------------------------------------------

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_PRICE_ID: string;
  STRIPE_AGENCY_PRICE_ID: string;
  STRIPE_ENTERPRISE_PRICE_ID: string;
  PUBLIC_BASE_URL: string;
  USER_STATE: DurableObjectNamespace;
  // QuickBooks Online OAuth + API config
  QUICKBOOKS_CLIENT_ID: string;
  QUICKBOOKS_CLIENT_SECRET: string;
  QUICKBOOKS_REDIRECT_URI: string;
  QUICKBOOKS_STATE_SECRET: string;
  QUICKBOOKS_ENVIRONMENT?: "sandbox" | "production";
}

// ---------------------------------------------------------------------------
// MCP ToolResult shape (shared across tools)
// ---------------------------------------------------------------------------

export interface ToolResult {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Middleware wrapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (input: any, env: any, authContext: any) => Promise<any>;

function withMiddleware(handler: AnyHandler, env: Env, request: Request) {
  return async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const authContext = await authenticateRequest(request, env);
      return await handler(params, env, authContext);
    } catch (err) {
      return toMcpError(err) as ToolResult;
    }
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(env: Env, request: Request): McpServer {
  const server = new McpServer({
    name: "buildaudit",
    version: "0.1.0",
  });

  server.tool(
    "analyze_jobs",
    "Rank jobs by profitability, identify jobs losing money, compute margin distribution, and total dollar exposure on underwater jobs.",
    analyzeJobsSchema.shape,
    withMiddleware(handleAnalyzeJobs, env, request)
  );

  server.tool(
    "audit_expenses",
    "Audit expenses for missing purchase orders, unassigned jobs, duplicate payments, and cost-code inconsistencies.",
    auditExpensesSchema.shape,
    withMiddleware(handleAuditExpenses, env, request)
  );

  server.tool(
    "variance_alerts",
    "Flag jobs whose actual costs exceed estimated costs by more than a threshold (default 25%). Returns alerts sorted by severity.",
    varianceAlertsSchema.shape,
    withMiddleware(handleVarianceAlerts, env, request)
  );

  server.tool(
    "commission_audit",
    "Audit commission payments against margin thresholds. Flags jobs where commission was paid below the minimum margin floor, detects same-week rate inconsistencies, and calculates total commission exposure.",
    commissionAuditSchema.shape,
    withMiddleware(handleCommissionAudit, env, request)
  );

  server.tool(
    "cash_flow",
    "Project cash flow over the next 90 days based on active jobs. Shows weekly inflows/outflows, identifies when cash might go negative, and calculates total projected cash position.",
    cashFlowSchema.shape,
    withMiddleware(handleCashFlow, env, request)
  );

  server.tool(
    "quickbooks_sync",
    "Pull live job and expense data from the caller's connected QuickBooks Online file. Returns { jobs, expenses } shaped like the other tools' inputs, so the LLM can chain this into analyze_jobs, audit_expenses, etc. without re-uploading anything. Requires the user to have authorized via /qb/connect first.",
    quickbooksSyncSchema.shape,
    withMiddleware(handleQuickBooksSync, env, request)
  );

  return server;
}
