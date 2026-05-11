# BuildAudit MCP

**Financial intelligence for contractors — job profitability, expense audit, and variance alerts as MCP tools.**

MVP scope: three tools that accept JSON/CSV data directly. QuickBooks integration is the next milestone.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `analyze_jobs` | Array of job objects | Profitability ranking, jobs losing money, average margin, margin distribution, total exposure on underwater jobs |
| `audit_expenses` | Array of expense objects | Unaudited spend (no PO), spend by vendor, unassigned expenses, duplicate detection, cost-code consistency |
| `variance_alerts` | Array of jobs + threshold % | Jobs over threshold cost overrun, sorted by severity, with dollar overrun amount |

All three tools also accept raw CSV via `csv_text` and use fuzzy header matching (e.g., `Job Name`, `Project`, `Work Order` → `jobName`).

## Local dev

```bash
npm install
npm run dev        # wrangler dev on http://localhost:8787
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

The MCP endpoint is `POST /mcp`. Smoke-test it without auth (anonymous = free tier):

```bash
curl -sS -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Architecture

Mirrors the QuantRisk MCP pattern:

- **Cloudflare Worker** as the only runtime
- **Durable Object** (`UserState`) for per-user auth + tier state, keyed by API key
- **WebStandardStreamableHTTPServerTransport** in stateless JSON mode — no SSE, no session storage
- **Stripe checkout** routes (`/upgrade`, `/checkout`, `/checkout/success`, `/checkout/cancel`) scaffolded but unconfigured for MVP
- **Auth middleware** — `Authorization: Bearer <api_key>` validates against the DO; no header = anonymous free tier

## License

MIT
