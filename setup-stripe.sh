#!/bin/bash
set -e

echo "=== BuildAudit — Stripe + Domain Setup ==="
echo ""

# Get Stripe key
if [ -z "$STRIPE_SECRET_KEY" ]; then
  echo "Paste your Stripe LIVE secret key (sk_live_...):"
  read -s STRIPE_SECRET_KEY
  echo "(key received)"
fi

echo ""
echo "--- Creating Stripe Products & Prices ---"

# Product 1: BuildAudit Pro ($49/mo)
echo "Creating BuildAudit Pro product..."
PRO_PRODUCT=$(curl -s https://api.stripe.com/v1/products \
  -u "$STRIPE_SECRET_KEY:" \
  -d "name=BuildAudit Pro" \
  -d "description=Full audit suite for contractors — job profitability, expense audit, variance alerts, unlimited jobs, QuickBooks connection." \
  -d "metadata[product]=buildaudit_pro" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Product: $PRO_PRODUCT"

PRO_PRICE=$(curl -s https://api.stripe.com/v1/prices \
  -u "$STRIPE_SECRET_KEY:" \
  -d "product=$PRO_PRODUCT" \
  -d "unit_amount=4900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=pro" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Price:   $PRO_PRICE ($49/mo)"

# Product 2: BuildAudit Agency ($149/mo)
echo "Creating BuildAudit Agency product..."
AGENCY_PRODUCT=$(curl -s https://api.stripe.com/v1/products \
  -u "$STRIPE_SECRET_KEY:" \
  -d "name=BuildAudit Agency" \
  -d "description=Multi-client management for bookkeepers/accountants — up to 10 QuickBooks connections, MCP access, batch audits." \
  -d "metadata[product]=buildaudit_agency" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Product: $AGENCY_PRODUCT"

AGENCY_PRICE=$(curl -s https://api.stripe.com/v1/prices \
  -u "$STRIPE_SECRET_KEY:" \
  -d "product=$AGENCY_PRODUCT" \
  -d "unit_amount=14900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=agency" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Price:   $AGENCY_PRICE ($149/mo)"

# Product 3: BuildAudit Enterprise ($499/mo)
echo "Creating BuildAudit Enterprise product..."
ENT_PRODUCT=$(curl -s https://api.stripe.com/v1/products \
  -u "$STRIPE_SECRET_KEY:" \
  -d "name=BuildAudit Enterprise" \
  -d "description=Unlimited clients, custom rules, API access, white-label reports — for accounting firms and franchises." \
  -d "metadata[product]=buildaudit_enterprise" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Product: $ENT_PRODUCT"

ENT_PRICE=$(curl -s https://api.stripe.com/v1/prices \
  -u "$STRIPE_SECRET_KEY:" \
  -d "product=$ENT_PRODUCT" \
  -d "unit_amount=49900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=enterprise" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Price:   $ENT_PRICE ($499/mo)"

echo ""
echo "--- Creating Stripe Webhook ---"

WORKER_URL="https://api.buildaudit.dev"

WEBHOOK=$(curl -s https://api.stripe.com/v1/webhook_endpoints \
  -u "$STRIPE_SECRET_KEY:" \
  -d "url=${WORKER_URL}/stripe-webhook" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=invoice.payment_failed")

WEBHOOK_SECRET=$(echo "$WEBHOOK" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")
echo "  Webhook secret: ${WEBHOOK_SECRET:0:12}..."

echo ""
echo "--- Setting Wrangler Secrets ---"

echo "$STRIPE_SECRET_KEY" | npx wrangler secret put STRIPE_SECRET_KEY
echo "$WEBHOOK_SECRET" | npx wrangler secret put STRIPE_WEBHOOK_SECRET

echo ""
echo "--- Updating wrangler.toml with Pro price ID ---"

# Update the price ID in wrangler.toml
sed -i.bak "s/STRIPE_PRO_PRICE_ID = \"price_TBD\"/STRIPE_PRO_PRICE_ID = \"$PRO_PRICE\"/" wrangler.toml
rm -f wrangler.toml.bak

echo ""
echo "--- Redeploying with updated config ---"

npx wrangler deploy

echo ""
echo "=== DONE ==="
echo ""
echo "Stripe Products Created:"
echo "  Pro:        $PRO_PRICE  (\$49/mo)"
echo "  Agency:     $AGENCY_PRICE  (\$149/mo)"
echo "  Enterprise: $ENT_PRICE  (\$499/mo)"
echo ""
echo "Webhook:    ${WORKER_URL}/stripe-webhook"
echo "Worker:     ${WORKER_URL}"
echo ""
echo "Checkout:   ${WORKER_URL}/checkout"
echo ""
echo "Save these price IDs — you'll need Agency and Enterprise"
echo "when you add tier selection to the upgrade page."
