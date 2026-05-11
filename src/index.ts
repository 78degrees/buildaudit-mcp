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

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "buildaudit-mcp", version: "0.1.0" }, 200);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        name: "BuildAudit MCP",
        description: "Financial intelligence for contractors — job profitability, expense audit, variance alerts.",
        version: "0.1.0",
        mcp_endpoint: "/mcp",
        upgrade: "/upgrade",
        tools: ["analyze_jobs", "audit_expenses", "variance_alerts"],
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

  const stripe = new StripeService(env);
  let session;
  try {
    session = await stripe.createCheckoutSession({
      priceId:    env.STRIPE_PRO_PRICE_ID,
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
        "Missing checkout session",
        "This page must be opened with a `session_id` from Stripe. Start over from /upgrade.",
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
        "Session missing API key",
        "This checkout session has no api_key metadata — likely created outside our flow.",
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
        "Could not save your API key",
        "Your payment went through, but we hit a snag saving the key. Email hello@buildaudit.dev with your receipt.",
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
</style>
`;

function renderUpgradePage(): string {
  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit Pro — Upgrade</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">BuildAudit Pro</span>
  <h1>Financial intelligence for <span>contractors</span>.</h1>
  <p class="lead">Job profitability, expense audit, and variance alerts — straight from your AI assistant. Subscribe to unlock paid-tier limits.</p>
  <div class="card">
    <a href="/checkout" class="btn">Subscribe to Pro &rarr;</a>
  </div>
  <h2>What you get</h2>
  <p>After payment we generate a fresh <code>ba_…</code> API key, link it to your subscription, and show it on the next screen with install instructions.</p>
</div></body></html>`;
}

function renderSuccessPage(apiKey: string, paid: boolean): string {
  const safeKey = escapeHtml(apiKey);
  const head = paid ? `Welcome to <span>BuildAudit Pro</span>.` : `Your account is set up.`;
  const sub = paid
    ? "Your API key is ready. Add it to your environment and your AI assistant will start hitting paid-tier endpoints immediately."
    : "Your subscription isn't active yet, but your key is reserved. Check Stripe to confirm the payment.";

  return /* html */ `<!doctype html><html lang="en"><head>
  <title>BuildAudit — Your API Key</title>${PAGE_HEAD}
</head><body><div class="wrap">
  <span class="badge">${paid ? "Subscription active" : "Pending"}</span>
  <h1>${head}</h1>
  <p class="lead">${sub}</p>

  <h2>Your API key</h2>
  <div class="key-box">
    <code id="apiKey">${safeKey}</code>
    <button class="copy-btn" id="copyBtn" onclick="copyKey()">Copy</button>
  </div>
  <p style="font-size:0.85rem;">Save this somewhere safe. Treat it like a password.</p>

  <h2>Install instructions</h2>
  <pre>export BUILDAUDIT_API_KEY=${safeKey}</pre>

  <h2>MCP client config</h2>
  <pre>{
  "mcpServers": {
    "buildaudit": {
      "transport": "http",
      "url": "${escapeHtml("https://buildaudit-mcp.example.workers.dev/mcp")}",
      "headers": { "Authorization": "Bearer ${safeKey}" }
    }
  }
}</pre>

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
