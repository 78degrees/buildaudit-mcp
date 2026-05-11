/**
 * index.ts — Cloudflare Worker entry point for BuildAudit MCP.
 *
 * Routes:
 *   POST /mcp              → MCP Streamable HTTP transport (stateless, JSON mode)
 *   POST /stripe-webhook   → Stripe webhook (tier upgrades/downgrades)
 *   GET  /upgrade          → HTML upgrade page
 *   GET  /checkout         → 303 redirect to Stripe Checkout
 *   GET  /checkout/success → claims the API key and displays it
 *   GET  /checkout/cancel  → cancel landing
 *   GET  /health           → health check
 *   GET  /                 → service summary (JSON)
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, type Env } from "./server.js";
import { StripeService }          from "./services/stripe.js";
import { handleAnalyzeJobs }      from "./tools/analyze-jobs.js";
import { handleAuditExpenses }    from "./tools/audit-expenses.js";
import { handleCommissionAudit }  from "./tools/commission-audit.js";
import { handleCashFlow }         from "./tools/cash-flow.js";
import * as XLSX                  from "xlsx";

export { UserState } from "./auth/user-state.js";

// ---------------------------------------------------------------------------
// Worker default export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === "/mcp" &&
      (request.method === "POST" || request.method === "GET" || request.method === "DELETE")
    ) {
      try {
        return await handleMcp(request, env);
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error("[MCP ERROR]", msg);
        return jsonResponse({ error: "INTERNAL", message: msg }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/upgrade") {
      return htmlResponse(renderUpgradePage(), 200);
    }

    if (request.method === "GET" && url.pathname === "/checkout") {
      return handleCheckout(request, env);
    }

    if (request.method === "GET" && url.pathname === "/checkout/success") {
      return handleCheckoutSuccess(request, env);
    }

    if (request.method === "GET" && url.pathname === "/checkout/cancel") {
      return htmlResponse(renderCancelPage(), 200);
    }

    if (request.method === "GET" && url.pathname === "/try-free") {
      return htmlResponse(renderTryFreePage(), 200);
    }

    if (request.method === "POST" && url.pathname === "/try-free") {
      return handleTryFreeUpload(request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "buildaudit-mcp", version: "0.1.0" }, 200);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderDashboardPage(), 200);
    }

    if (request.method === "GET" && url.pathname === "/api-info") {
      return jsonResponse({
        name: "BuildAudit",
        version: "0.1.0",
        mcp_endpoint: "/mcp",
        tools: ["analyze_jobs", "audit_expenses", "variance_alerts", "commission_audit", "cash_flow"],
      }, 200);
    }

    return jsonResponse(
      { error: "NOT_FOUND", message: `No route for ${request.method} ${url.pathname}` },
      404
    );
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const server = createServer(env, request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    transport.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Checkout — initiate Stripe Checkout Session
// ---------------------------------------------------------------------------

async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const url     = new URL(request.url);
  const baseUrl = env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const apiKey  = generateApiKey();
  const tier    = (url.searchParams.get("tier") ?? "pro").toLowerCase();

  // Map tier query param → Stripe price ID. Unknown values fall through to Pro.
  const priceId =
    tier === "agency"     ? env.STRIPE_AGENCY_PRICE_ID :
    tier === "enterprise" ? env.STRIPE_ENTERPRISE_PRICE_ID :
                            env.STRIPE_PRO_PRICE_ID;

  const stripe = new StripeService(env);
  let session;
  try {
    session = await stripe.createCheckoutSession({
      priceId,
      apiKey,
      successUrl: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${baseUrl}/checkout/cancel`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[checkout] createCheckoutSession failed:", msg);
    return htmlResponse(
      renderErrorPage(
        "Couldn't start checkout",
        "We had trouble creating a Stripe Checkout Session. Try again in a moment.",
        msg,
      ),
      502,
    );
  }
  return Response.redirect(session.url!, 303);
}

// ---------------------------------------------------------------------------
// Checkout success — claim the API key
// ---------------------------------------------------------------------------

async function handleCheckoutSuccess(request: Request, env: Env): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("session_id");

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return htmlResponse(
      renderErrorPage(
        "Missing checkout info",
        "This page needs to be opened right after checkout. Head back to the pricing page to try again.",
      ),
      400,
    );
  }

  const stripe  = new StripeService(env);
  const session = await stripe.retrieveCheckoutSession(sessionId);
  if (!session) {
    return htmlResponse(
      renderErrorPage(
        "Checkout session not found",
        "Stripe could not find that session. It may have expired.",
      ),
      404,
    );
  }

  const apiKey = (session.metadata?.api_key as string | undefined) ?? null;
  if (!apiKey) {
    return htmlResponse(
      renderErrorPage(
        "Something went wrong",
        "We couldn't set up your account from this checkout session. Please try again from the pricing page, or email hello@buildaudit.dev if this keeps happening.",
      ),
      400,
    );
  }

  const customerId = typeof session.customer === "string"
    ? session.customer
    : session.customer?.id ?? null;
  const subscriptionId = typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id ?? null;
  const customerObj =
    typeof session.customer === "object" && session.customer && !("deleted" in session.customer && session.customer.deleted)
      ? session.customer
      : null;
  const email = session.customer_details?.email ?? customerObj?.email ?? null;

  const paid =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required" ||
    session.status === "complete";

  try {
    await setKeyOnDo(env, apiKey, {
      tier:                 paid ? "paid" : "free",
      email,
      stripeCustomerId:     customerId,
      stripeSubscriptionId: subscriptionId,
    });
  } catch (err) {
    console.error("[checkout/success] set-key failed:", err);
    return htmlResponse(
      renderErrorPage(
        "Account setup issue",
        "Your payment went through, but we hit a snag setting up your account. Email hello@buildaudit.dev with your receipt and we'll get you sorted.",
      ),
      500,
    );
  }

  return htmlResponse(renderSuccessPage(apiKey, paid), 200);
}

// ---------------------------------------------------------------------------
// Stripe webhook
// ---------------------------------------------------------------------------

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("Stripe-Signature");
  if (!signature) {
    return jsonResponse(
      { error: "MISSING_SIGNATURE", message: "Stripe-Signature header is required." },
      400
    );
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return jsonResponse({ error: "INVALID_BODY", message: "Could not read request body." }, 400);
  }

  const stripe = new StripeService(env);
  let result: Awaited<ReturnType<StripeService["handleWebhook"]>>;
  try {
    result = await stripe.handleWebhook(body, signature);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook verification failed.";
    return jsonResponse({ error: "WEBHOOK_VERIFICATION_FAILED", message }, 400);
  }

  if (!result) {
    return jsonResponse({ received: true }, 200);
  }

  if (result.newTier !== null && result.apiKey) {
    try {
      await setKeyOnDo(env, result.apiKey, {
        tier:                 result.newTier,
        stripeCustomerId:     result.customerId,
        stripeSubscriptionId: result.subscriptionId,
      });
    } catch (err) {
      console.error("[stripe-webhook] DO update failed:", err);
      return jsonResponse({ error: "INTERNAL_ERROR", message: "Failed to update user tier." }, 500);
    }
  } else if (result.newTier !== null && !result.apiKey) {
    console.warn(
      `[stripe-webhook] ${result.eventType} for sub=${result.subscriptionId} cust=${result.customerId} ` +
      `has no api_key metadata — skipping DO update.`
    );
  }

  return jsonResponse({ received: true }, 200);
}

// ---------------------------------------------------------------------------
// Try Free — upload CSV, run the matching tool, render results inline
// ---------------------------------------------------------------------------

async function handleTryFreeUpload(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return htmlResponse(
      renderErrorPage(
        "Couldn't read upload",
        "We expected a file upload. Try the form again.",
      ),
      400,
    );
  }

  const fileEntry = formData.get("csv");
  const type      = String(formData.get("type") ?? "jobs").toLowerCase();

  if (!fileEntry || typeof fileEntry === "string") {
    return htmlResponse(
      renderErrorPage(
        "No file uploaded",
        "Pick a spreadsheet before clicking Analyze.",
      ),
      400,
    );
  }

  const file = fileEntry as unknown as {
    size: number;
    name: string;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };

  if (file.size === 0) {
    return htmlResponse(
      renderErrorPage("Empty file", "Pick a non-empty file."),
      400,
    );
  }

  // Cap input at 5 MB for the free tier.
  if (file.size > 5 * 1024 * 1024) {
    return htmlResponse(
      renderErrorPage(
        "File too large",
        "Free tier accepts files up to 5 MB. Subscribe to Pro for larger uploads.",
      ),
      413,
    );
  }

  // Detect file type from extension and convert Excel → CSV if needed.
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  let csvText: string;

  if (ext === "xlsx" || ext === "xls" || ext === "xlsb" || ext === "ods") {
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) {
        return htmlResponse(
          renderErrorPage("Empty spreadsheet", "The uploaded file has no sheets."),
          400,
        );
      }
      csvText = XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheet]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return htmlResponse(
        renderErrorPage(
          "Couldn't read that spreadsheet",
          "We had trouble parsing the file. Make sure it's a valid Excel or spreadsheet file.",
          msg,
        ),
        400,
      );
    }
  } else {
    // Treat everything else (csv, tsv, txt) as plain text.
    csvText = await file.text();
  }

  // Route to the correct handler based on report type
  let handler: (input: any, env: any, auth: any) => Promise<any>;
  if (type === "expenses") {
    handler = handleAuditExpenses;
  } else if (type === "commissions") {
    handler = handleCommissionAudit;
  } else if (type === "cashflow") {
    handler = handleCashFlow;
  } else {
    handler = handleAnalyzeJobs;
  }
  const result = await handler({ csv_text: csvText } as any, {} as any, {});

  return htmlResponse(renderTryFreeResultPage(result, type, file.name), 200);
}

// ---------------------------------------------------------------------------
// DO helpers
// ---------------------------------------------------------------------------

interface SetKeyArgs {
  tier:                 "free" | "paid";
  email?:               string | null;
  stripeCustomerId:     string | null;
  stripeSubscriptionId: string | null;
}

async function setKeyOnDo(env: Env, apiKey: string, args: SetKeyArgs): Promise<void> {
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(apiKey));
  const response = await stub.fetch(
    new Request("https://user-state/set-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ apiKey, ...args }),
    })
  );
  if (!response.ok) {
    throw new Error(`UserState DO returned ${response.status} for /set-key`);
  }
}

/**
 * Generate a BuildAudit API key: `ba_` + 32 lowercase hex chars from
 * crypto.randomUUID's random part.
 */
function generateApiKey(): string {
  return "ba_" + crypto.randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// HTML page templates
// ---------------------------------------------------------------------------

const PAGE_HEAD = /* html */ `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #0a0a0f;
    --surface:   #14141c;
    --surface-2: #1c1c28;
    --border:    #2a2a38;
    --text:      #e8e8ee;
    --muted:     #8a8a9a;
    --accent:    #6366f1;
    --accent-2:  #818cf8;
    --success:   #22c55e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    line-height: 1.55; min-height: 100vh;
    display: flex; flex-direction: column; align-items: center;
    padding: 4rem 1.5rem;
  }
  .wrap { width: 100%; max-width: 640px; }
  h1 { font-size: 2.25rem; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
  h1 span { color: var(--accent-2); }
  h2 { font-size: 1.05rem; font-weight: 600; margin: 2rem 0 0.75rem; }
  p { color: var(--muted); margin-bottom: 1rem; }
  .lead { font-size: 1.05rem; color: var(--text); margin-bottom: 2rem; }
  code, pre, .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.75rem; }
  .btn {
    display: inline-block; background: var(--accent); color: white; border: none;
    padding: 0.875rem 1.5rem; border-radius: 0.5rem;
    font-family: 'Inter', sans-serif; font-size: 1rem; font-weight: 600;
    text-decoration: none; cursor: pointer; transition: background 0.15s;
    width: 100%; text-align: center;
  }
  .btn:hover { background: var(--accent-2); }
  .btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-ghost:hover { background: var(--surface-2); border-color: var(--accent); }
  .key-box {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem;
    padding: 1rem; margin: 0.5rem 0 1rem;
    display: flex; align-items: center; gap: 0.75rem;
  }
  .key-box code { flex: 1; word-break: break-all; font-size: 0.9rem; color: var(--accent-2); }
  .copy-btn {
    flex-shrink: 0; background: var(--accent); color: white; border: none;
    padding: 0.5rem 0.875rem; border-radius: 0.375rem; font-size: 0.85rem;
    font-weight: 600; cursor: pointer; font-family: 'Inter', sans-serif;
  }
  .copy-btn.copied { background: var(--success); }
  pre {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem;
    padding: 1rem; overflow-x: auto; font-size: 0.85rem; color: var(--text);
    margin: 0.5rem 0 1rem;
  }
  .badge {
    display: inline-block; background: rgba(99, 102, 241, 0.15); color: var(--accent-2);
    border: 1px solid rgba(99, 102, 241, 0.4);
    padding: 0.25rem 0.625rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
    letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 1rem;
  }
  /* Wider container for pricing grids + result pages */
  .wrap-wide { width: 100%; max-width: 1080px; }
  .pricing-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1.5rem 0;
  }
  @media (max-width: 900px) { .pricing-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 540px) { .pricing-grid { grid-template-columns: 1fr; } }
  .tier {
    background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem;
    padding: 1.25rem; display: flex; flex-direction: column;
  }
  .tier.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .tier h3 { margin: 0 0 0.25rem; font-size: 1rem; font-weight: 600; }
  .tier .pricing-line { display: flex; align-items: baseline; gap: 0.25rem; margin-bottom: 0.75rem; }
  .tier .pricing-line .num { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; }
  .tier .pricing-line .per { color: var(--muted); font-size: 0.85rem; }
  .tier ul { list-style: none; padding: 0; margin: 0 0 1rem; font-size: 0.85rem; flex: 1; }
  .tier ul li {
    color: var(--text); padding: 0.25rem 0; padding-left: 1.1rem; position: relative;
  }
  .tier ul li::before {
    content: "✓"; position: absolute; left: 0; color: var(--accent-2); font-weight: 600;
  }
  .tier .btn { margin-top: auto; padding: 0.625rem 1rem; font-size: 0.9rem; }
  .upload-form {
    background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem;
    padding: 1.5rem; margin: 1rem 0;
  }
  .upload-form input[type=file] {
    width: 100%; padding: 0.75rem; background: var(--surface-2); border: 1px dashed var(--border);
    border-radius: 0.5rem; color: var(--text); cursor: pointer;
  }
  .upload-form .radio-row {
    display: flex; gap: 1rem; margin: 1rem 0;
  }
  .upload-form .radio-row label {
    display: flex; align-items: center; gap: 0.5rem; cursor: pointer;
    padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem;
    background: var(--surface-2);
  }
  .upload-form .radio-row input[type=radio] { accent-color: var(--accent); }
  .summary-card {
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--accent); border-radius: 0.5rem;
    padding: 1rem 1.25rem; margin: 1rem 0; font-size: 0.95rem; line-height: 1.6;
  }
  .stat-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem; margin: 1rem 0;
  }
  .stat {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .stat .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .value { font-size: 1.25rem; font-weight: 600; margin-top: 0.25rem; }
  .stat .value.danger { color: #f87171; }
  .stat .value.success { color: var(--success); }
</style>
`;

function renderUpgradePage(): string {
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Pricing</title>${PAGE_HEAD}
</head><body><div class="wrap wrap-wide">
  <span class="badge">Pricing</span>
  <h1>Find the leak in your <span>job costs</span>.</h1>
  <p class="lead">Pick a plan or try BuildAudit free by uploading a spreadsheet — no card, no signup.</p>

  <div class="pricing-grid">

    <div class="tier">
      <h3>Free</h3>
      <div class="pricing-line"><span class="num">$0</span><span class="per">one-shot upload</span></div>
      <ul>
        <li>Upload one spreadsheet</li>
        <li>Profitability, expense, commission &amp; cash flow reports</li>
        <li>Duplicate &amp; PO audit</li>
        <li>No signup, no card</li>
      </ul>
      <a href="/try-free" class="btn btn-ghost">Try free &rarr;</a>
    </div>

    <div class="tier featured">
      <h3>Pro</h3>
      <div class="pricing-line"><span class="num">$49</span><span class="per">/ month</span></div>
      <ul>
        <li>Unlimited jobs &amp; expenses</li>
        <li>Connect QuickBooks directly</li>
        <li>Full financial dashboard</li>
        <li>Email &amp; text alerts when jobs go over budget</li>
      </ul>
      <a href="/checkout?tier=pro" class="btn">Get Pro &rarr;</a>
    </div>

    <div class="tier">
      <h3>Agency</h3>
      <div class="pricing-line"><span class="num">$149</span><span class="per">/ month</span></div>
      <ul>
        <li>Everything in Pro</li>
        <li>Up to 10 QuickBooks connections</li>
        <li>Batch audits across clients</li>
        <li>Branded PDF reports</li>
      </ul>
      <a href="/checkout?tier=agency" class="btn">Get Agency &rarr;</a>
    </div>

    <div class="tier">
      <h3>Enterprise</h3>
      <div class="pricing-line"><span class="num">$499</span><span class="per">/ month</span></div>
      <ul>
        <li>Unlimited clients</li>
        <li>Custom audit rules &amp; cost codes</li>
        <li>White-label reports with your branding</li>
        <li>Priority support</li>
      </ul>
      <a href="/checkout?tier=enterprise" class="btn">Get Enterprise &rarr;</a>
    </div>

  </div>

  <h2>What happens after you sign up</h2>
  <p>After payment you'll get immediate access to your BuildAudit account. Connect QuickBooks, upload your job data, and start seeing results right away.</p>
</div></body></html>`;
}

function renderTryFreePage(): string {
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Try free</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">Free — no signup</span>
  <h1>Drop in a <span>spreadsheet</span> and see what's bleeding.</h1>
  <p class="lead">Export jobs or expenses from QuickBooks, Excel, Google Sheets — anywhere. We accept .xlsx, .xls, .csv, and .ods files and fuzzy-match the headers (Project, Work Order, Job Name… all map to the same field).</p>

  <form class="upload-form" method="POST" action="/try-free" enctype="multipart/form-data">

    <label for="csv-file"><strong>Pick a spreadsheet</strong></label>
    <p style="font-size: 0.85rem; margin: 0.5rem 0 1rem;">Up to 5 MB. Stays in this browser session — nothing is stored on our servers in the free tier.</p>
    <input id="csv-file" type="file" name="csv" accept=".csv,.xlsx,.xls,.xlsb,.ods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" required>

    <div class="radio-row" style="flex-wrap: wrap;">
      <label><input type="radio" name="type" value="jobs" checked> Job profitability</label>
      <label><input type="radio" name="type" value="expenses"> Expense audit</label>
      <label><input type="radio" name="type" value="commissions"> Commission check</label>
      <label><input type="radio" name="type" value="cashflow"> Cash flow forecast</label>
    </div>

    <button type="submit" class="btn">Analyze &rarr;</button>
  </form>

  <h2>What to expect</h2>
  <ul style="list-style: none; padding-left: 0;">
    <li style="padding: 0.25rem 0;">— <strong>Job profitability</strong> → ranking by profit + jobs losing money + margin distribution + total exposure on underwater jobs.</li>
    <li style="padding: 0.25rem 0;">— <strong>Expense audit</strong> → unaudited spend (no PO) + spend by vendor + unassigned expenses + duplicate detection + cost-code consistency.</li>
    <li style="padding: 0.25rem 0;">— <strong>Commission check</strong> → flags every job where commission was paid below your margin floor + catches same-week rate inconsistencies.</li>
    <li style="padding: 0.25rem 0;">— <strong>Cash flow forecast</strong> → projects your cash position over the next 90 days, week by week, and warns you before it goes negative.</li>
  </ul>

  <h2>Required columns (fuzzy-matched)</h2>
  <p style="font-size: 0.9rem;"><strong>Jobs:</strong> Job Name (or "Project", "Work Order"…), Estimated Revenue, Actual Revenue, Estimated Costs, Actual Costs, Status, Start Date, End Date.</p>
  <p style="font-size: 0.9rem;"><strong>Expenses:</strong> Vendor (or "Supplier", "Payee"…), Amount (or "Total", "Cost"…), Date, Job Name, PO (or "Has PO", "PO Number"…), Cost Code, Description.</p>

  <p style="margin-top: 2rem; font-size: 0.9rem;">Want unlimited uploads + QuickBooks connection + ongoing monitoring? <a href="/upgrade" style="color: var(--accent-2);">See plans &rarr;</a></p>
</div></body></html>`;
}

function renderTryFreeResultPage(
  result: { content: [{ type: string; text: string }]; isError?: boolean },
  type: string,
  filename: string,
): string {
  const safeName = escapeHtml(filename);
  const headline =
    type === "expenses"     ? "Expense audit" :
    type === "commissions"  ? "Commission audit" :
    type === "cashflow"     ? "Cash flow forecast" :
                              "Job profitability scan";

  if (result.isError) {
    let detail = "";
    try {
      const e = JSON.parse(result.content[0].text);
      detail = `${e.error}: ${e.message}`;
    } catch {
      detail = result.content[0].text;
    }
    const typeLabel = type === "expenses" ? "expenses" : type === "commissions" ? "commissions" : type === "cashflow" ? "cash flow" : "jobs";
    return renderErrorPage(
      "Couldn't parse that file",
      `We tried to analyze ${safeName} as a ${escapeHtml(typeLabel)} export, but something went sideways.`,
      detail,
    );
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch {
    parsed = {};
  }

  const summary = escapeHtml(parsed.summary ?? "");

  // Build stat grid + body specific to each tool
  let stats: string[] = [];
  let body = "";

  if (type === "commissions") {
    stats = [
      `<div class="stat"><div class="label">Jobs analyzed</div><div class="value">${parsed.total_jobs ?? 0}</div></div>`,
      `<div class="stat"><div class="label">Below margin floor</div><div class="value danger">${parsed.jobs_below_floor ?? 0}</div></div>`,
      `<div class="stat"><div class="label">Commission exposure</div><div class="value danger">${formatMoney(parsed.commission_exposure)}</div></div>`,
      `<div class="stat"><div class="label">Margin floor</div><div class="value">${formatPct(parsed.margin_floor_used)}</div></div>`,
    ];

    const flagged = (parsed.flagged_jobs ?? []).slice(0, 10);
    body += flagged.length > 0
      ? `<h2>Jobs where commission shouldn't have been paid</h2>
         <table style="width:100%; border-collapse: collapse; font-size:0.9rem; margin: 0.5rem 0 1.5rem;">
           <thead><tr style="text-align:left; color: var(--muted); border-bottom: 1px solid var(--border);">
             <th style="padding:0.5rem 0.25rem;">Job</th><th>Revenue</th><th>Margin</th><th>Commission paid</th>
           </tr></thead><tbody>
           ${flagged.map((j: any) => `
             <tr style="border-bottom: 1px solid var(--border);">
               <td style="padding:0.5rem 0.25rem;">${escapeHtml(j.jobName)}</td>
               <td>${formatMoney(j.actualRevenue)}</td>
               <td style="color:#f87171;">${formatPct(j.margin)}</td>
               <td style="color:#f87171;">${formatMoney(j.commissionPaid)}</td>
             </tr>`).join("")}
         </tbody></table>`
      : `<p style="color: var(--success); font-size: 0.95rem;">All commissioned jobs meet your margin threshold.</p>`;

    const inconsistencies = (parsed.rate_inconsistencies ?? []).slice(0, 5);
    if (inconsistencies.length > 0) {
      body += `<h2>Same-week rate inconsistencies</h2>
        <ul style="font-size: 0.9rem;">
          ${inconsistencies.map((r: any) => `<li style="padding: 0.25rem 0;">Week of ${escapeHtml(r.week)}: ${formatPct(r.spread)} spread across ${(r.jobs ?? []).length} jobs</li>`).join("")}
        </ul>`;
    }
  } else if (type === "cashflow") {
    stats = [
      `<div class="stat"><div class="label">Projected inflows</div><div class="value success">${formatMoney(parsed.total_projected_inflows)}</div></div>`,
      `<div class="stat"><div class="label">Projected outflows</div><div class="value danger">${formatMoney(parsed.total_projected_outflows)}</div></div>`,
      `<div class="stat"><div class="label">Lowest balance</div><div class="value ${(parsed.lowest_balance ?? 0) < 0 ? "danger" : ""}">${formatMoney(parsed.lowest_balance)}</div></div>`,
      `<div class="stat"><div class="label">Days until negative</div><div class="value ${parsed.days_until_negative ? "danger" : "success"}">${parsed.days_until_negative ?? "Never"}</div></div>`,
    ];

    const timeline = (parsed.weekly_timeline ?? []).slice(0, 13);
    if (timeline.length > 0) {
      body += `<h2>Weekly cash flow</h2>
        <table style="width:100%; border-collapse: collapse; font-size:0.9rem; margin: 0.5rem 0 1.5rem;">
          <thead><tr style="text-align:left; color: var(--muted); border-bottom: 1px solid var(--border);">
            <th style="padding:0.5rem 0.25rem;">Week</th><th>In</th><th>Out</th><th>Net</th><th>Balance</th>
          </tr></thead><tbody>
          ${timeline.map((w: any) => `
            <tr style="border-bottom: 1px solid var(--border);">
              <td style="padding:0.5rem 0.25rem;">${escapeHtml(w.week)}</td>
              <td style="color: var(--success);">${formatMoney(w.inflows)}</td>
              <td style="color:#f87171;">${formatMoney(w.outflows)}</td>
              <td style="color:${(w.net ?? 0) >= 0 ? "var(--success)" : "#f87171"};">${formatMoney(w.net)}</td>
              <td style="color:${(w.running_balance ?? 0) >= 0 ? "var(--text)" : "#f87171"}; font-weight:600;">${formatMoney(w.running_balance)}</td>
            </tr>`).join("")}
        </tbody></table>`;
    }
  } else if (type === "jobs" || type !== "expenses") {
    stats = [
      `<div class="stat"><div class="label">Jobs analyzed</div><div class="value">${parsed.count_total ?? 0}</div></div>`,
      `<div class="stat"><div class="label">Underwater</div><div class="value danger">${parsed.count_underwater ?? 0}</div></div>`,
      `<div class="stat"><div class="label">Total exposure</div><div class="value danger">${formatMoney(parsed.total_exposure_underwater)}</div></div>`,
      `<div class="stat"><div class="label">Average margin</div><div class="value ${(parsed.average_margin ?? 0) >= 0 ? "success" : "danger"}">${formatPct(parsed.average_margin)}</div></div>`,
    ];

    const losers = (parsed.jobs_losing_money ?? []).slice(0, 10);
    body += losers.length > 0
      ? `<h2>Jobs losing money</h2>
         <table style="width:100%; border-collapse: collapse; font-size:0.9rem; margin: 0.5rem 0 1.5rem;">
           <thead><tr style="text-align:left; color: var(--muted); border-bottom: 1px solid var(--border);">
             <th style="padding:0.5rem 0.25rem;">Job</th><th>Revenue</th><th>Costs</th><th>Profit</th><th>Margin</th>
           </tr></thead><tbody>
           ${losers.map((j: any) => `
             <tr style="border-bottom: 1px solid var(--border);">
               <td style="padding:0.5rem 0.25rem;">${escapeHtml(j.jobName)}</td>
               <td>${formatMoney(j.actualRevenue)}</td>
               <td>${formatMoney(j.actualCosts)}</td>
               <td style="color:#f87171;">${formatMoney(j.profit)}</td>
               <td style="color:#f87171;">${formatPct(j.margin)}</td>
             </tr>`).join("")}
         </tbody></table>`
      : `<p style="color: var(--success); font-size: 0.95rem;">No jobs underwater — every job is at least breaking even.</p>`;

    const ranked = (parsed.profitability_ranking ?? []).slice(0, 5);
    if (ranked.length > 0) {
      body += `<h2>Top 5 by profit</h2>
        <ol style="font-size: 0.9rem;">
          ${ranked.map((j: any) => `<li style="padding: 0.25rem 0;">${escapeHtml(j.jobName)} — ${formatMoney(j.profit)} (${formatPct(j.margin)})</li>`).join("")}
        </ol>`;
    }
  } else {
    stats = [
      `<div class="stat"><div class="label">Expenses</div><div class="value">${parsed.total_expenses ?? 0}</div></div>`,
      `<div class="stat"><div class="label">Unaudited spend</div><div class="value danger">${formatMoney(parsed.total_unaudited_spend)}</div></div>`,
      `<div class="stat"><div class="label">Unassigned</div><div class="value">${(parsed.unassigned_expenses ?? []).length}</div></div>`,
      `<div class="stat"><div class="label">Duplicate groups</div><div class="value danger">${(parsed.duplicates ?? []).length}</div></div>`,
    ];

    const dups = (parsed.duplicates ?? []).slice(0, 10);
    body += dups.length > 0
      ? `<h2>Possible duplicates</h2>
         <table style="width:100%; border-collapse: collapse; font-size:0.9rem; margin: 0.5rem 0 1.5rem;">
           <thead><tr style="text-align:left; color: var(--muted); border-bottom: 1px solid var(--border);">
             <th style="padding:0.5rem 0.25rem;">Vendor</th><th>Amount</th><th>Count</th><th>Dates</th>
           </tr></thead><tbody>
           ${dups.map((g: any) => `
             <tr style="border-bottom: 1px solid var(--border);">
               <td style="padding:0.5rem 0.25rem;">${escapeHtml(g.vendor)}</td>
               <td>${formatMoney(g.amount)}</td>
               <td>${g.count}</td>
               <td>${escapeHtml((g.dates ?? []).join(", "))}</td>
             </tr>`).join("")}
         </tbody></table>`
      : `<p style="color: var(--success); font-size: 0.95rem;">No duplicate groups detected within the 7-day window.</p>`;

    const byVendor = (parsed.expenses_by_vendor ?? []).slice(0, 5);
    if (byVendor.length > 0) {
      body += `<h2>Top vendors by spend</h2>
        <ol style="font-size: 0.9rem;">
          ${byVendor.map((v: any) => `<li style="padding: 0.25rem 0;">${escapeHtml(v.vendor)} — ${formatMoney(v.total)} across ${v.count} expense(s)</li>`).join("")}
        </ol>`;
    }
  }

  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — ${escapeHtml(headline)}</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">${escapeHtml(headline)}</span>
  <h1>Here's what we found in <span>${safeName}</span>.</h1>

  <div class="summary-card">${summary}</div>

  <div class="stat-grid">${stats.join("")}</div>

  ${body}

  <h2>Want this on every job, automatically?</h2>
  <p>Pro plan ($49/mo) unlocks unlimited uploads, QuickBooks connection, ongoing monitoring, and email alerts when jobs go over budget.</p>
  <a href="/upgrade" class="btn">See plans &rarr;</a>

  <p style="margin-top: 1.5rem; font-size: 0.85rem;"><a href="/try-free" style="color: var(--muted);">&larr; Try another file</a></p>
</div></body></html>`;
}

function formatMoney(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

function renderDashboardPage(): string {
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Dashboard</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">BuildAudit</span>
  <h1>Your financial <span>command center</span>.</h1>
  <p class="lead">Upload a spreadsheet to get an instant audit, or choose a report type below.</p>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 2rem 0;">
    <a href="/try-free" class="card" style="text-decoration: none; color: var(--text); transition: border-color 0.15s;">
      <h3 style="margin: 0 0 0.5rem; font-size: 1rem;">Job profitability</h3>
      <p style="font-size: 0.85rem; margin: 0;">See which jobs are making money and which are underwater.</p>
    </a>
    <a href="/try-free" class="card" style="text-decoration: none; color: var(--text); transition: border-color 0.15s;">
      <h3 style="margin: 0 0 0.5rem; font-size: 1rem;">Expense audit</h3>
      <p style="font-size: 0.85rem; margin: 0;">Find missing POs, duplicates, and unassigned expenses.</p>
    </a>
    <a href="/try-free" class="card" style="text-decoration: none; color: var(--text); transition: border-color 0.15s;">
      <h3 style="margin: 0 0 0.5rem; font-size: 1rem;">Commission check</h3>
      <p style="font-size: 0.85rem; margin: 0;">Flag jobs where commission was paid below your margin floor.</p>
    </a>
    <a href="/try-free" class="card" style="text-decoration: none; color: var(--text); transition: border-color 0.15s;">
      <h3 style="margin: 0 0 0.5rem; font-size: 1rem;">Cash flow forecast</h3>
      <p style="font-size: 0.85rem; margin: 0;">See where your cash is headed over the next 90 days.</p>
    </a>
  </div>

  <div style="display: flex; gap: 1rem; margin-top: 1rem;">
    <a href="/try-free" class="btn" style="flex:1;">Upload a spreadsheet &rarr;</a>
    <a href="/upgrade" class="btn btn-ghost" style="flex:1;">See plans</a>
  </div>
</div></body></html>`;
}

function renderSuccessPage(apiKey: string, paid: boolean): string {
  const safeKey = escapeHtml(apiKey);
  const head = paid ? `Welcome to <span>BuildAudit Pro</span>.` : `Your account is set up.`;
  const sub = paid
    ? "You're all set. Your account is active and ready to use. Save your account key below — you'll need it to log in."
    : "Your subscription isn't active yet, but your account is reserved. Check your email for a payment confirmation.";

  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Welcome</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">${paid ? "Subscription active" : "Pending"}</span>
  <h1>${head}</h1>
  <p class="lead">${sub}</p>

  <h2>Your account key</h2>
  <div class="key-box">
    <code id="apiKey">${safeKey}</code>
    <button class="copy-btn" id="copyBtn" onclick="copyKey()">Copy</button>
  </div>
  <p style="font-size:0.85rem;">Save this somewhere safe — you'll need it to access your account. Treat it like a password.</p>

  <h2>What's next</h2>
  <p>Head to your <a href="/" style="color: var(--accent-2);">BuildAudit dashboard</a> to connect QuickBooks or upload your first file. Your account is live and ready to go.</p>

  <script>
    function copyKey() {
      const key = document.getElementById('apiKey').textContent;
      const btn = document.getElementById('copyBtn');
      navigator.clipboard.writeText(key).then(() => {
        btn.textContent = 'Copied ✓';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      }).catch(() => { btn.textContent = 'Press ⌘C'; });
    }
  </script>
</div></body></html>`;
}

function renderCancelPage(): string {
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Checkout cancelled</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">Cancelled</span>
  <h1>No charge made.</h1>
  <p class="lead">You backed out of checkout — totally fine. Whenever you're ready, you can pick up where you left off.</p>
  <a href="/upgrade" class="btn">Try again &rarr;</a>
</div></body></html>`;
}

function renderErrorPage(title: string, message: string, detail?: string): string {
  const safeTitle = escapeHtml(title);
  const safeMsg   = escapeHtml(message);
  const detailHtml = detail ? `<pre>${escapeHtml(detail)}</pre>` : "";
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — ${safeTitle}</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">Error</span>
  <h1>${safeTitle}</h1>
  <p class="lead">${safeMsg}</p>
  ${detailHtml}
  <a href="/upgrade" class="btn">Back to upgrade</a>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type":           "text/html; charset=utf-8",
      "Cache-Control":          "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy":        "strict-origin-when-cross-origin",
    },
  });
}
