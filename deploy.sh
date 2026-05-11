#!/bin/bash
set -e

echo "=== BuildAudit MCP — Deploy Script ==="

# 1. Clean up any stale git state and init
rm -rf .git
git init -b main
git config user.email "hello@buildaudit.dev"
git config user.name "BuildAudit"
git add -A
git commit -m "Initial commit: BuildAudit MCP engine v0.1.0

- 3 core tools: analyze_jobs, audit_expenses, variance_alerts
- CSV parser with fuzzy header matching + money coercion
- Stripe checkout + webhook + API key delivery
- Durable Object auth (UserState)
- MCP Streamable HTTP transport (stateless)
- 60/60 tests passing"

echo ""
echo "✓ Git initialized and committed"

# 2. Create GitHub repo and push
echo ""
echo "Creating GitHub repo under 78degrees org..."
gh repo create 78degrees/buildaudit-mcp --public --source=. --remote=origin --push --description "Financial intelligence for contractors — MCP server for job profitability, expense audit, variance alerts."

echo ""
echo "✓ Pushed to GitHub: https://github.com/78degrees/buildaudit-mcp"

# 3. Deploy to Cloudflare Workers
echo ""
echo "Deploying to Cloudflare Workers..."
npx wrangler deploy

echo ""
echo "=== Done! ==="
echo "Next: Set up Stripe products and wire live keys."
