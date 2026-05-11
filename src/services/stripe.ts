/**
 * StripeService — checkout sessions, subscription status, webhook processing.
 *
 * Uses the Stripe npm SDK with the Cloudflare Workers runtime adapter
 * (httpClient: Stripe.createFetchHttpClient()).
 */

import Stripe from "stripe";

export interface StripeEnv {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

export type UserTier = "free" | "paid";

export class StripeService {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(env: StripeEnv) {
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-04-10",
      httpClient: Stripe.createFetchHttpClient(),
    });
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Create a Checkout Session. The `apiKey` is embedded in both session
   * metadata and `subscription_data.metadata` so /checkout/success and the
   * webhook can both find the right UserState DO to claim.
   */
  async createCheckoutSession(args: {
    priceId: string;
    apiKey: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string | null;
  }): Promise<Stripe.Checkout.Session> {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode:        "subscription",
      line_items:  [{ price: args.priceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url:  args.cancelUrl,
      metadata: {
        source:  "buildaudit-mcp",
        api_key: args.apiKey,
      },
      subscription_data: {
        metadata: {
          source:  "buildaudit-mcp",
          api_key: args.apiKey,
        },
      },
    };
    if (args.customerEmail) {
      params.customer_email = args.customerEmail;
    }

    const session = await this.stripe.checkout.sessions.create(params);
    if (!session.url) {
      throw new Error("Stripe Checkout Session created but returned no URL");
    }
    return session;
  }

  async retrieveCheckoutSession(
    sessionId: string
  ): Promise<Stripe.Checkout.Session | null> {
    try {
      return await this.stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription", "customer"],
      });
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async verifyWebhook(body: string, signature: string): Promise<Stripe.Event> {
    return this.stripe.webhooks.constructEventAsync(body, signature, this.webhookSecret);
  }

  async handleWebhook(
    body: string,
    signature: string
  ): Promise<WebhookResult | null> {
    const event = await this.verifyWebhook(body, signature);

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const isActive = sub.status === "active" || sub.status === "trialing";
        return {
          eventType:      event.type,
          customerId,
          subscriptionId: sub.id,
          apiKey:         subscriptionApiKey(sub),
          newTier:        isActive ? "paid" : "free",
        };
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        return {
          eventType:      event.type,
          customerId,
          subscriptionId: sub.id,
          apiKey:         subscriptionApiKey(sub),
          newTier:        "free",
        };
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id ?? null;
        if (!customerId) return null;
        return {
          eventType:      event.type,
          customerId,
          subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id ?? null,
          apiKey:         null,
          newTier:        null, // Stripe will retry; no immediate tier change
        };
      }
      default:
        return null;
    }
  }
}

function subscriptionApiKey(sub: Stripe.Subscription): string | null {
  const v = sub.metadata?.api_key;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export interface WebhookResult {
  eventType: string;
  customerId: string;
  subscriptionId: string | null;
  apiKey: string | null;
  newTier: UserTier | null;
}
