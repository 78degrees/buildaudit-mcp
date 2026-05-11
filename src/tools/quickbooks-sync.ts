/**
 * quickbooks_sync — pull live data from the caller's connected QBO file.
 *
 * Requires:
 *   - Caller authenticated with Bearer API key (not anonymous)
 *   - That apiKey's DO has stored OAuth tokens (i.e. /qb/connect ran)
 *
 * Returns { jobs, expenses } shaped exactly like the other tools' inputs,
 * so the caller can chain into analyze_jobs / audit_expenses / etc.
 */

import type { QuickbooksSyncInput } from "../schemas/quickbooks-sync.js";
import type { Env, ToolResult } from "../server.js";
import type { AuthContext } from "../middleware/auth.js";
import type { Job } from "../types/job.js";
import type { Expense } from "../types/expense.js";
import { QuickBooksService, type QbTokens } from "../services/quickbooks.js";
import { AuthError, BuildAuditError, toMcpError } from "../utils/errors.js";

export interface QuickBooksSyncEnv extends Env {}

export async function handleQuickBooksSync(
  input: QuickbooksSyncInput,
  env: QuickBooksSyncEnv,
  auth: AuthContext,
): Promise<ToolResult> {
  try {
    if (auth.isAnonymous) {
      throw new AuthError(
        "QuickBooks sync requires a paid API key. Subscribe at https://buildaudit.dev/upgrade.",
      );
    }

    // Verify the worker has Intuit credentials wired up
    if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET) {
      throw new BuildAuditError(
        "COMPUTATION_ERROR",
        "QuickBooks integration is not yet configured on this server.",
      );
    }

    // Load this user's QBO tokens from the DO
    const stub = env.USER_STATE.get(env.USER_STATE.idFromName(auth.userId));
    const r = await stub.fetch(new Request("https://user-state/get-qb-tokens"));
    if (!r.ok) {
      throw new BuildAuditError("COMPUTATION_ERROR", `UserState DO returned ${r.status} for /get-qb-tokens`);
    }
    const stored = await r.json<{
      connected: boolean;
      realmId: string | null;
      accessToken: string | null;
      refreshToken: string | null;
      accessTokenExpiresAt: number | null;
    }>();

    if (!stored.connected || !stored.realmId || !stored.refreshToken) {
      throw new BuildAuditError(
        "AUTH_REQUIRED",
        "QuickBooks is not connected for this account. Visit https://api.buildaudit.dev/qb/connect?api_key=<your-key> to authorize.",
      );
    }

    // Refresh access token if it's within 60s of expiring (or already expired)
    const qb = new QuickBooksService(env);
    let tokens: QbTokens = {
      realmId:              stored.realmId,
      accessToken:          stored.accessToken ?? "",
      refreshToken:         stored.refreshToken,
      accessTokenExpiresAt: stored.accessTokenExpiresAt ?? 0,
    };

    if (!tokens.accessToken || tokens.accessTokenExpiresAt - Date.now() < 60_000) {
      tokens = await qb.refreshTokens(tokens.refreshToken, tokens.realmId);
      // Persist the new tokens immediately
      await stub.fetch(new Request("https://user-state/set-qb-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          realmId:              tokens.realmId,
          accessToken:          tokens.accessToken,
          refreshToken:         tokens.refreshToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        }),
      }));
    }

    // Fetch whatever was requested
    let jobs:     Job[]     | undefined;
    let expenses: Expense[] | undefined;

    if (input.pull === "jobs" || input.pull === "both") {
      jobs = await qb.fetchJobs(tokens.accessToken, tokens.realmId);
    }
    if (input.pull === "expenses" || input.pull === "both") {
      expenses = await qb.fetchExpenses(tokens.accessToken, tokens.realmId);
    }

    const summary =
      `Pulled ` +
      (jobs     ? `${jobs.length} job${jobs.length !== 1 ? "s" : ""}` : "") +
      (jobs && expenses ? " and " : "") +
      (expenses ? `${expenses.length} expense${expenses.length !== 1 ? "s" : ""}` : "") +
      ` from QuickBooks (realm ${tokens.realmId}).`;

    const result: {
      jobs?: Job[];
      expenses?: Expense[];
      realm_id: string;
      summary: string;
    } = { realm_id: tokens.realmId, summary };
    if (jobs)     result.jobs     = jobs;
    if (expenses) result.expenses = expenses;

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return toMcpError(err) as ToolResult;
  }
}
