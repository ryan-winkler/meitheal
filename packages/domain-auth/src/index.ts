export interface IngressContext {
  ingressPath?: string;
  hassioTokenPresent: boolean;
}

export function canAutoLoginViaIngress(ctx: IngressContext): boolean {
  return Boolean(ctx.ingressPath && ctx.hassioTokenPresent);
}

// ── Agent Token Domain ──
export {
  type AgentScope,
  type AgentScopeDescriptor,
  type AgentTokenRecord,
  type AgentTokenCreated,
  type AgentTokenPublic,
  AVAILABLE_SCOPES,
  generateAgentToken,
  hashToken,
  validateScopes,
  hasScope,
  toPublicToken,
} from "./agent-tokens"

// ── License Key Verification ──

import { createPublicKey, verify } from "node:crypto"

/** Ed25519 public key for offline license verification (can only verify, not sign) */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEVuOXG8QwGBje5IiLxLip7hpFekpY+6BbunJ7VP1aRU=
-----END PUBLIC KEY-----`

export type LicensePlan = "personal" | "household" | "commercial" | "none"

export interface LicenseValid {
  valid: true
  plan: LicensePlan
  email: string
  expiresAt: string | null
  issuedAt: string
}

export interface LicenseInvalid {
  valid: false
  reason: string
  plan: "none"
}

export interface LicenseGrace {
  valid: true
  plan: "none"
  email: null
  expiresAt: null
  issuedAt: null
  grace: true
}

export type LicenseResult = LicenseValid | LicenseInvalid | LicenseGrace

/**
 * Verify an offline JWT license key using the embedded production Ed25519
 * public key. Production code should use this entry point.
 */
export function verifyLicenseKey(token: string | undefined | null): LicenseResult {
  return verifyLicenseKeyWithPublicKey(token, LICENSE_PUBLIC_KEY_PEM)
}

/**
 * Verify an offline JWT license key against an explicit Ed25519 public key.
 *
 * This keeps signature verification deterministic in tests and key-rotation
 * tooling without requiring access to the production signing private key.
 */
export function verifyLicenseKeyWithPublicKey(
  token: string | undefined | null,
  publicKeyPem: string,
): LicenseResult {
  // Grace mode: no key provided — app runs freely
  if (!token || token.trim() === "") {
    return { valid: true, plan: "none", email: null, expiresAt: null, issuedAt: null, grace: true }
  }

  try {
    const parts = token.trim().split(".")
    if (parts.length !== 3) {
      return { valid: false, reason: "invalid_format", plan: "none" }
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    // Decode header
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString())
    if (header.alg !== "EdDSA") {
      return { valid: false, reason: "unsupported_algorithm", plan: "none" }
    }

    // Verify signature before trusting any payload fields.
    const publicKey = createPublicKey(publicKeyPem)
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`)
    const signature = Buffer.from(signatureB64, "base64url")

    const isValid = verify(null, signingInput, publicKey, signature)
    if (!isValid) {
      return { valid: false, reason: "invalid_signature", plan: "none" }
    }

    // Decode payload only after signature verification.
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString())

    // Check issuer
    if (payload.iss !== "meitheal") {
      return { valid: false, reason: "invalid_issuer", plan: "none" }
    }

    // Check expiry
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000)
      if (now > payload.exp) {
        return { valid: false, reason: "expired", plan: "none" }
      }
    }

    // Validate plan
    const validPlans: LicensePlan[] = ["personal", "household", "commercial"]
    const plan: LicensePlan = validPlans.includes(payload.plan) ? payload.plan : "personal"

    return {
      valid: true,
      plan,
      email: payload.sub || "unknown",
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : new Date().toISOString()
    }
  } catch {
    return { valid: false, reason: "decode_error", plan: "none" }
  }
}

export { isAssignedTaskScopedRoute, isTaskReactionRoute, resolveAgentRouteScope } from "./agent-route-policy"
