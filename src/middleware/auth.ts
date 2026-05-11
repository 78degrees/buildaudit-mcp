/**
 * Bearer-token auth middleware.
 *
 * No Authorization header → free-tier anonymous user keyed by client IP.
 * Authorization: Bearer <key> → validate against the UserState DO; reject
 * unknown or revoked keys with AuthError.
 */

import { AuthError } from "../utils/errors.js";
import type { UserTier } from "../services/stripe.js";

export interface AuthEnv {
  USER_STATE: DurableObjectNamespace;
}

export interface AuthContext {
  userId: string;
  email: string | null;
  tier: UserTier;
  stripeCustomerId: string | null;
  isAnonymous: boolean;
}

export async function authenticateRequest(
  request: Request,
  env: AuthEnv
): Promise<AuthContext> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return buildAnonymousContext(request);
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthError(
      'Malformed Authorization header. Expected format: "Authorization: Bearer <api-key>"'
    );
  }

  const apiKey = authHeader.slice("Bearer ".length).trim();
  if (!apiKey || apiKey.length < 20) {
    throw new AuthError("API key is too short or missing.");
  }

  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(apiKey));
  const response = await stub.fetch(
    new Request("https://user-state/validate-key", { method: "GET" })
  );

  if (!response.ok) {
    throw new AuthError("Failed to validate API key. Please try again.");
  }

  const validation = await response.json<ValidateKeyResponse>();
  if (!validation.valid) {
    throw new AuthError(
      "Invalid or revoked API key. Subscribe at /upgrade to get a key."
    );
  }

  return {
    userId:           apiKey,
    email:            validation.email,
    tier:             validation.tier ?? "free",
    stripeCustomerId: validation.stripeCustomerId,
    isAnonymous:      false,
  };
}

function buildAnonymousContext(request: Request): AuthContext {
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    "unknown";

  return {
    userId:           `anon:${ip}`,
    email:            null,
    tier:             "free",
    stripeCustomerId: null,
    isAnonymous:      true,
  };
}

interface ValidateKeyResponse {
  valid: boolean;
  tier: UserTier | null;
  email: string | null;
  stripeCustomerId: string | null;
}
