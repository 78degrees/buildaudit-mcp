/**
 * Typed error classes for BuildAudit MCP.
 * Mirrors QuantRisk's pattern — every error carries a machine-readable code,
 * a human-readable message, and an optional upgrade URL for tier errors.
 */

export type BuildAuditErrorCode =
  | "INVALID_INPUT"
  | "AUTH_REQUIRED"
  | "TIER_REQUIRED"
  | "RATE_LIMITED"
  | "COMPUTATION_ERROR";

export interface BuildAuditErrorPayload {
  error: BuildAuditErrorCode;
  message: string;
  upgrade_url?: string;
  [key: string]: unknown;
}

export class BuildAuditError extends Error {
  readonly code: BuildAuditErrorCode;
  readonly upgradeUrl?: string;

  constructor(code: BuildAuditErrorCode, message: string, upgradeUrl?: string) {
    super(message);
    this.name = "BuildAuditError";
    this.code = code;
    this.upgradeUrl = upgradeUrl;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toPayload(): BuildAuditErrorPayload {
    const p: BuildAuditErrorPayload = { error: this.code, message: this.message };
    if (this.upgradeUrl) p.upgrade_url = this.upgradeUrl;
    return p;
  }
}

export class InvalidInputError extends BuildAuditError {
  readonly field?: string;
  readonly received?: unknown;

  constructor(field: string, detail?: string, received?: unknown) {
    const msg = detail
      ? `Invalid value for "${field}": ${detail}`
      : `Invalid value for "${field}"`;
    super("INVALID_INPUT", msg);
    this.name = "InvalidInputError";
    this.field = field;
    this.received = received;
  }

  toPayload(): BuildAuditErrorPayload {
    return { ...super.toPayload(), field: this.field, received: this.received };
  }
}

export class AuthError extends BuildAuditError {
  constructor(
    message = "Authentication required. Provide a valid API key in the Authorization header as a Bearer token."
  ) {
    super("AUTH_REQUIRED", message);
    this.name = "AuthError";
  }
}

export class ComputationError extends BuildAuditError {
  constructor(message: string) {
    super("COMPUTATION_ERROR", message);
    this.name = "ComputationError";
  }
}

/**
 * Normalise any thrown value into a structured MCP error response body.
 */
export function toMcpError(err: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  let payload: BuildAuditErrorPayload;
  if (err instanceof BuildAuditError) {
    payload = err.toPayload();
  } else if (err instanceof Error) {
    payload = { error: "COMPUTATION_ERROR", message: err.message };
  } else {
    payload = { error: "COMPUTATION_ERROR", message: "An unexpected error occurred." };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
