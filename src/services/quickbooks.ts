/**
 * QuickBooksService — OAuth 2.0 client + thin REST client for QuickBooks Online.
 *
 * Token lifecycle:
 *   - Access token: ~1 hour. Used as Bearer on every API call.
 *   - Refresh token: ~100 days. Used to mint new access tokens; itself
 *     rotates on each refresh (Intuit returns a fresh one in the response).
 *
 * The service is stateless — callers pass in the tokens they have, the
 * service hands back fresh ones when needed. Storage is the UserState DO's
 * concern (see /set-qb-tokens).
 *
 * Environment / sandbox switch:
 *   QUICKBOOKS_ENVIRONMENT=sandbox|production toggles the API base URL.
 *   OAuth endpoints are the same for both.
 */

import type { Job } from "../types/job.js";
import type { Expense } from "../types/expense.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const INTUIT_TOKEN_URL     = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const INTUIT_REVOKE_URL    = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

const API_BASE_PRODUCTION  = "https://quickbooks.api.intuit.com/v3/company";
const API_BASE_SANDBOX     = "https://sandbox-quickbooks.api.intuit.com/v3/company";

const SCOPE_ACCOUNTING     = "com.intuit.quickbooks.accounting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuickBooksEnv {
  QUICKBOOKS_CLIENT_ID: string;
  QUICKBOOKS_CLIENT_SECRET: string;
  QUICKBOOKS_REDIRECT_URI: string;
  QUICKBOOKS_ENVIRONMENT?: "sandbox" | "production";
  // Used to HMAC-sign the OAuth `state` parameter so we can prove a
  // callback came from a flow we initiated.
  QUICKBOOKS_STATE_SECRET: string;
}

export interface QbTokens {
  realmId:               string;
  accessToken:           string;
  refreshToken:          string;
  accessTokenExpiresAt:  number; // Unix ms
}

interface TokenResponse {
  access_token:         string;
  refresh_token:        string;
  expires_in:           number;   // seconds until access_token expires
  x_refresh_token_expires_in?: number;
  token_type:           string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class QuickBooksService {
  private readonly clientId:     string;
  private readonly clientSecret: string;
  private readonly redirectUri:  string;
  private readonly apiBase:      string;
  private readonly stateSecret:  string;

  constructor(env: QuickBooksEnv) {
    this.clientId     = env.QUICKBOOKS_CLIENT_ID;
    this.clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
    this.redirectUri  = env.QUICKBOOKS_REDIRECT_URI;
    this.stateSecret  = env.QUICKBOOKS_STATE_SECRET;
    this.apiBase = (env.QUICKBOOKS_ENVIRONMENT ?? "production") === "sandbox"
      ? API_BASE_SANDBOX
      : API_BASE_PRODUCTION;
  }

  // -------------------------------------------------------------------------
  // OAuth: state token (HMAC-signed)
  // -------------------------------------------------------------------------

  /**
   * Build a tamper-evident OAuth `state` token that encodes the user's
   * apiKey. Format: `<apiKey>.<nonce>.<base64-hmac>`.
   * On callback we verify the signature before trusting the apiKey.
   */
  async signState(apiKey: string): Promise<string> {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const payload = `${apiKey}.${nonce}`;
    const sig = await this.hmac(payload);
    return `${payload}.${sig}`;
  }

  /** Returns the apiKey if the state token is valid; null otherwise. */
  async verifyState(state: string): Promise<string | null> {
    const parts = state.split(".");
    if (parts.length !== 3) return null;
    const [apiKey, nonce, sig] = parts;
    const expected = await this.hmac(`${apiKey}.${nonce}`);
    return constantTimeEqual(sig, expected) ? apiKey : null;
  }

  private async hmac(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.stateSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return base64UrlEncode(new Uint8Array(sig));
  }

  // -------------------------------------------------------------------------
  // OAuth: authorize URL + token exchange + refresh
  // -------------------------------------------------------------------------

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id:     this.clientId,
      response_type: "code",
      scope:         SCOPE_ACCOUNTING,
      redirect_uri:  this.redirectUri,
      state,
    });
    return `${INTUIT_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, realmId: string): Promise<QbTokens> {
    const resp = await this.tokenRequest({
      grant_type:   "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });
    return {
      realmId,
      accessToken:          resp.access_token,
      refreshToken:         resp.refresh_token,
      accessTokenExpiresAt: Date.now() + resp.expires_in * 1000,
    };
  }

  async refreshTokens(currentRefreshToken: string, realmId: string): Promise<QbTokens> {
    const resp = await this.tokenRequest({
      grant_type:    "refresh_token",
      refresh_token: currentRefreshToken,
    });
    return {
      realmId,
      accessToken:          resp.access_token,
      // Intuit rotates the refresh token; use whichever comes back.
      refreshToken:         resp.refresh_token,
      accessTokenExpiresAt: Date.now() + resp.expires_in * 1000,
    };
  }

  async revoke(token: string): Promise<void> {
    await fetch(INTUIT_REVOKE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${this.basicAuth()}`,
        "Accept":        "application/json",
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ token }),
    });
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const resp = await fetch(INTUIT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${this.basicAuth()}`,
        "Accept":        "application/json",
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Intuit token endpoint returned ${resp.status}: ${text}`);
    }
    return resp.json<TokenResponse>();
  }

  private basicAuth(): string {
    return btoa(`${this.clientId}:${this.clientSecret}`);
  }

  // -------------------------------------------------------------------------
  // API: query
  // -------------------------------------------------------------------------

  /**
   * Run a QBO SQL-like query and return the raw response. The caller is
   * responsible for providing a valid (unexpired) access token; if you need
   * auto-refresh, use `withFreshTokens` from index.ts which wraps this.
   */
  async query<T = unknown>(
    accessToken: string,
    realmId: string,
    sql: string,
  ): Promise<T> {
    const url = `${this.apiBase}/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
    const resp = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept":        "application/json",
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`QBO API ${resp.status}: ${text.slice(0, 300)}`);
    }
    return resp.json<T>();
  }

  // -------------------------------------------------------------------------
  // Domain: pull jobs + expenses, map to BuildAudit types
  // -------------------------------------------------------------------------

  /**
   * Pull Customer-as-Job records from QBO and aggregate Invoices + Purchases
   * into per-job actualRevenue / actualCosts.
   *
   * Limitations of this MVP mapping:
   *   - estimatedRevenue defaults to actualRevenue (we'd need to read
   *     Estimate.txn to get a real estimate).
   *   - estimatedCosts defaults to 0 unless the QBO file uses budget classes.
   *   - We use Customer.Active=true only; archived customers are skipped.
   *   - Multi-currency files: amounts are returned in the customer's currency
   *     without conversion. Single-currency QBO files behave correctly.
   */
  async fetchJobs(accessToken: string, realmId: string): Promise<Job[]> {
    // Pull customers (a customer marked as a "Job" in QBO is a project).
    const customerResp = await this.query<{ QueryResponse: { Customer?: QboCustomer[] } }>(
      accessToken,
      realmId,
      "SELECT Id, DisplayName, Active, Job, ParentRef FROM Customer WHERE Active = true MAXRESULTS 1000",
    );
    const customers = customerResp.QueryResponse?.Customer ?? [];

    // Invoices give us actualRevenue
    const invoiceResp = await this.query<{ QueryResponse: { Invoice?: QboInvoice[] } }>(
      accessToken,
      realmId,
      "SELECT Id, CustomerRef, TotalAmt, TxnDate FROM Invoice WHERE TxnDate > '2020-01-01' MAXRESULTS 1000",
    );
    const invoices = invoiceResp.QueryResponse?.Invoice ?? [];

    // Purchases give us actualCosts (Bills could be added similarly)
    const purchaseResp = await this.query<{ QueryResponse: { Purchase?: QboPurchase[] } }>(
      accessToken,
      realmId,
      "SELECT Id, EntityRef, TotalAmt, TxnDate, Line FROM Purchase WHERE TxnDate > '2020-01-01' MAXRESULTS 1000",
    );
    const purchases = purchaseResp.QueryResponse?.Purchase ?? [];

    // Aggregate by customer ID
    const revByCustomer  = new Map<string, number>();
    const costByCustomer = new Map<string, number>();
    const firstTxnByCustomer = new Map<string, string>();
    const lastTxnByCustomer  = new Map<string, string>();

    for (const inv of invoices) {
      const id = inv.CustomerRef?.value;
      if (!id) continue;
      revByCustomer.set(id, (revByCustomer.get(id) ?? 0) + (inv.TotalAmt ?? 0));
      trackDate(firstTxnByCustomer, lastTxnByCustomer, id, inv.TxnDate);
    }

    // Purchases use Line[].AccountBasedExpenseLineDetail.CustomerRef to link
    // an expense to a job. EntityRef is the vendor, not the customer.
    for (const p of purchases) {
      for (const line of p.Line ?? []) {
        const cust = line.AccountBasedExpenseLineDetail?.CustomerRef?.value;
        if (cust) {
          costByCustomer.set(cust, (costByCustomer.get(cust) ?? 0) + (line.Amount ?? 0));
          trackDate(firstTxnByCustomer, lastTxnByCustomer, cust, p.TxnDate);
        }
      }
    }

    const jobs: Job[] = customers
      .filter(c => c.Job === true || c.ParentRef != null)
      .map(c => {
        const actualRevenue = revByCustomer.get(c.Id)  ?? 0;
        const actualCosts   = costByCustomer.get(c.Id) ?? 0;
        return {
          jobName:           c.DisplayName,
          estimatedRevenue:  actualRevenue,    // QBO Customer has no estimate field; use actual as fallback
          actualRevenue,
          estimatedCosts:    0,                 // No native field; user can upload estimate CSV separately
          actualCosts,
          status:            "active",           // Could be inferred from Customer.Active + recent activity
          startDate:         firstTxnByCustomer.get(c.Id) ?? todayIso(),
          endDate:           lastTxnByCustomer.get(c.Id) ?? null,
        };
      });

    return jobs;
  }

  /**
   * Pull Purchase line items (each one is one expense) and Bill line items,
   * mapping vendor + amount + cost-code (Class) + linked job.
   */
  async fetchExpenses(accessToken: string, realmId: string): Promise<Expense[]> {
    const purchaseResp = await this.query<{ QueryResponse: { Purchase?: QboPurchase[] } }>(
      accessToken,
      realmId,
      "SELECT Id, EntityRef, TotalAmt, TxnDate, PrivateNote, DocNumber, Line FROM Purchase WHERE TxnDate > '2020-01-01' MAXRESULTS 1000",
    );
    const purchases = purchaseResp.QueryResponse?.Purchase ?? [];

    // Pull customers + classes for name resolution
    const [customerResp, classResp] = await Promise.all([
      this.query<{ QueryResponse: { Customer?: QboCustomer[] } }>(
        accessToken, realmId,
        "SELECT Id, DisplayName FROM Customer MAXRESULTS 1000",
      ),
      this.query<{ QueryResponse: { Class?: { Id: string; Name: string }[] } }>(
        accessToken, realmId,
        "SELECT Id, Name FROM Class MAXRESULTS 1000",
      ),
    ]);
    const customerNameById = new Map<string, string>(
      (customerResp.QueryResponse?.Customer ?? []).map(c => [c.Id, c.DisplayName]),
    );
    const classNameById = new Map<string, string>(
      (classResp.QueryResponse?.Class ?? []).map(c => [c.Id, c.Name]),
    );

    const expenses: Expense[] = [];
    for (const p of purchases) {
      const vendor = p.EntityRef?.name ?? p.EntityRef?.value ?? "Unknown Vendor";
      for (const line of p.Line ?? []) {
        const detail = line.AccountBasedExpenseLineDetail;
        if (!detail) continue; // skip non-expense lines
        const customerId = detail.CustomerRef?.value ?? null;
        const classId    = detail.ClassRef?.value ?? null;
        expenses.push({
          vendor,
          amount:            line.Amount ?? 0,
          date:              p.TxnDate,
          jobName:           customerId ? (customerNameById.get(customerId) ?? null) : null,
          // QBO doesn't carry a PO flag on Purchase — proxy: any DocNumber implies a tracked reference.
          hasPurchaseOrder:  Boolean(p.DocNumber && p.DocNumber.trim().length > 0),
          costCode:          classId ? (classNameById.get(classId) ?? null) : null,
          description:       line.Description ?? p.PrivateNote ?? "",
        });
      }
    }
    return expenses;
  }
}

// ---------------------------------------------------------------------------
// QBO API entity types — partial, only the fields we read
// ---------------------------------------------------------------------------

interface QboCustomer {
  Id:           string;
  DisplayName:  string;
  Active?:      boolean;
  Job?:         boolean;
  ParentRef?:   { value: string };
}

interface QboInvoice {
  Id:           string;
  CustomerRef?: { value: string; name?: string };
  TotalAmt?:    number;
  TxnDate:      string; // YYYY-MM-DD
}

interface QboPurchase {
  Id:           string;
  EntityRef?:   { value: string; name?: string; type?: string };
  TotalAmt?:    number;
  TxnDate:      string;
  PrivateNote?: string;
  DocNumber?:   string;
  Line?:        QboLine[];
}

interface QboLine {
  Id?:                              string;
  Amount?:                          number;
  Description?:                     string;
  AccountBasedExpenseLineDetail?: {
    AccountRef?:    { value: string; name?: string };
    CustomerRef?:   { value: string; name?: string };
    ClassRef?:      { value: string; name?: string };
    BillableStatus?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trackDate(
  firstMap: Map<string, string>,
  lastMap:  Map<string, string>,
  id:       string,
  date:     string,
): void {
  if (!date) return;
  const prev = firstMap.get(id);
  if (!prev || date < prev) firstMap.set(id, date);
  const last = lastMap.get(id);
  if (!last || date > last) lastMap.set(id, date);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}
