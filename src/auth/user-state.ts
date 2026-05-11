/**
 * UserState — Cloudflare Durable Object for per-user auth + tier state.
 *
 * Keyed by API key (via `idFromName(apiKey)`). Free-tier anonymous callers
 * are keyed by `anon:<ip>`. Stripe subscription events claim the DO with
 * a `qr_…`-style key via POST /set-key.
 *
 * Internal HTTP routes:
 *   GET  /get               → full state snapshot
 *   GET  /validate-key      → { valid, tier, email, stripeCustomerId }
 *   POST /set-key           → claim DO with { apiKey, tier, email, ... }
 *   POST /invalidate        → mark key revoked
 */

import { DurableObject } from "cloudflare:workers";
import type { UserTier } from "../services/stripe.js";
import type { Env } from "../server.js";

interface UserStateData {
  userId: string | null;
  apiKey: string | null;
  apiKeyIssuedAt: number | null;
  email: string | null;
  tier: UserTier;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  invalidated: boolean;
}

export class UserState extends DurableObject<Env> {
  private data: UserStateData | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/get":
        return this.handleGet();
      case "/validate-key":
        return this.handleValidateKey();
      case "/set-key":
        return this.handleSetKey(request);
      case "/invalidate":
        return this.handleInvalidate();
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  private async handleGet(): Promise<Response> {
    const d = await this.getState();
    return json(d);
  }

  private async handleValidateKey(): Promise<Response> {
    const d = await this.getState();
    const valid = d.apiKey !== null && !d.invalidated;
    return json<ValidateKeyResponse>({
      valid,
      tier:             valid ? d.tier : null,
      email:            valid ? d.email : null,
      stripeCustomerId: valid ? d.stripeCustomerId : null,
    });
  }

  private async handleSetKey(request: Request): Promise<Response> {
    const body = await request.json<{
      apiKey: string;
      tier?: UserTier;
      email?: string | null;
      stripeCustomerId?: string | null;
      stripeSubscriptionId?: string | null;
    }>();
    const d = await this.getState();

    d.apiKey         = body.apiKey;
    d.userId         = body.apiKey;
    d.apiKeyIssuedAt = d.apiKeyIssuedAt ?? Date.now();
    if (body.tier !== undefined)                 d.tier                 = body.tier;
    if (body.email !== undefined)                d.email                = body.email ?? null;
    if (body.stripeCustomerId !== undefined)     d.stripeCustomerId     = body.stripeCustomerId ?? null;
    if (body.stripeSubscriptionId !== undefined) d.stripeSubscriptionId = body.stripeSubscriptionId ?? null;
    d.invalidated = false;

    await this.saveState(d);
    return json({ ok: true, apiKeyIssuedAt: d.apiKeyIssuedAt });
  }

  private async handleInvalidate(): Promise<Response> {
    const d = await this.getState();
    d.invalidated = true;
    await this.saveState(d);
    return json({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async getState(): Promise<UserStateData> {
    if (this.data !== null) return this.data;
    const stored = await this.ctx.storage.get<UserStateData>("state");
    if (stored) {
      this.data = stored;
    } else {
      this.data = {
        userId:               null,
        apiKey:               null,
        apiKeyIssuedAt:       null,
        email:                null,
        tier:                 "free",
        stripeCustomerId:     null,
        stripeSubscriptionId: null,
        invalidated:          false,
      };
    }
    return this.data;
  }

  private async saveState(d: UserStateData): Promise<void> {
    this.data = d;
    await this.ctx.storage.put("state", d);
  }
}

interface ValidateKeyResponse {
  valid: boolean;
  tier: UserTier | null;
  email: string | null;
  stripeCustomerId: string | null;
}

function json<T>(data: T): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
