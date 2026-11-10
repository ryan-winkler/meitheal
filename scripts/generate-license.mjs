#!/usr/bin/env node

/**
 * Meitheal License Key Generator
 *
 * Generates Ed25519-signed JWT license keys for offline validation.
 *
 * Usage:
 *   # First-time: generate keypair
 *   node scripts/generate-license.mjs --init
 *
 *   # Generate a license key
 *   node scripts/generate-license.mjs --email user@example.com --plan personal --expires 2027-01-01
 *
 *   # Inspect an existing key
 *   node scripts/generate-license.mjs --inspect <token>
 *
 * Plans: personal, household, commercial
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const KEYS_DIR = resolve(__dirname, "..", ".keys")
const PRIVATE_KEY_PATH = resolve(KEYS_DIR, "meitheal-license.pem")
const PUBLIC_KEY_PATH = resolve(KEYS_DIR, "meitheal-license.pub.pem")
const VALID_PLANS = ["personal", "household", "commercial"]

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function generateKeypair() {
  if (existsSync(PRIVATE_KEY_PATH)) {
    console.error("❌ Keypair already exists at", KEYS_DIR)
    console.error("   Delete .keys/ manually if you want to regenerate (this invalidates ALL existing keys)")
    process.exit(1)
  }

  mkdirSync(KEYS_DIR, { recursive: true })

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  })

  writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 })
  writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 })

  console.log("✅ Ed25519 keypair generated")
  console.log(`   Private key: ${PRIVATE_KEY_PATH}`)
  console.log(`   Public key:  ${PUBLIC_KEY_PATH}`)
  console.log()
  console.log("📋 Copy this public key into packages/domain-auth/src/index.ts:")
  console.log()
  console.log(publicKey)
}

function generateLicense({ email, plan, expires }) {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    console.error("❌ No keypair found. Run with --init first")
    process.exit(1)
  }

  if (!email) {
    console.error("❌ --email is required")
    process.exit(1)
  }

  if (!VALID_PLANS.includes(plan)) {
    console.error(`❌ --plan must be one of: ${VALID_PLANS.join(", ")}`)
    process.exit(1)
  }

  const privateKeyPem = readFileSync(PRIVATE_KEY_PATH, "utf-8")
  const privateKey = createPrivateKey(privateKeyPem)

  const now = Math.floor(Date.now() / 1000)

  const header = { alg: "EdDSA", typ: "JWT" }
  const payload = {
    iss: "meitheal",
    sub: email,
    plan,
    iat: now
  }

  if (expires) {
    const expDate = new Date(expires)
    if (isNaN(expDate.getTime())) {
      console.error("❌ Invalid --expires date. Use YYYY-MM-DD format")
      process.exit(1)
    }
    payload.exp = Math.floor(expDate.getTime() / 1000)
  }

  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const signature = sign(null, Buffer.from(signingInput), privateKey)
  const signatureB64 = base64url(signature)

  const token = `${signingInput}.${signatureB64}`

  console.log("✅ License key generated")
  console.log()
  console.log(`   Email:   ${email}`)
  console.log(`   Plan:    ${plan}`)
  console.log(`   Issued:  ${new Date(now * 1000).toISOString()}`)
  if (payload.exp) {
    console.log(`   Expires: ${new Date(payload.exp * 1000).toISOString()}`)
  } else {
    console.log("   Expires: never")
  }
  console.log()
  console.log("📋 License key (share this with the user):")
  console.log()
  console.log(token)
}

function inspectToken(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) {
      console.error("❌ Invalid token format (expected 3 parts)")
      process.exit(1)
    }

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())

    console.log("🔍 Token inspection:")
    console.log()
    console.log("Header:", JSON.stringify(header, null, 2))
    console.log()
    console.log("Payload:", JSON.stringify(payload, null, 2))
    console.log()

    if (payload.exp) {
      const expDate = new Date(payload.exp * 1000)
      const isExpired = Date.now() > expDate.getTime()
      console.log(`   Expires: ${expDate.toISOString()} ${isExpired ? "⚠️ EXPIRED" : "✅ valid"}`)
    } else {
      console.log("   Expires: never")
    }

    console.log()
    console.log("⚠️  Signature not verified (use the app for full validation)")
  } catch (err) {
    console.error("❌ Failed to decode token:", err.message)
    process.exit(1)
  }
}

// ── CLI ──
const args = process.argv.slice(2)

if (args.includes("--init")) {
  generateKeypair()
} else if (args.includes("--inspect")) {
  const idx = args.indexOf("--inspect")
  const token = args[idx + 1]
  if (!token) {
    console.error("❌ --inspect requires a token argument")
    process.exit(1)
  }
  inspectToken(token)
} else if (args.includes("--email")) {
  const getFlag = (name) => {
    const idx = args.indexOf(name)
    return idx !== -1 ? args[idx + 1] : undefined
  }
  generateLicense({
    email: getFlag("--email"),
    plan: getFlag("--plan") || "personal",
    expires: getFlag("--expires")
  })
} else {
  console.log(`Meitheal License Key Generator

Usage:
  node scripts/generate-license.mjs --init
    Generate Ed25519 keypair (one-time setup)

  node scripts/generate-license.mjs --email <email> [--plan <plan>] [--expires <YYYY-MM-DD>]
    Generate a signed license key

  node scripts/generate-license.mjs --inspect <token>
    Decode and inspect a license key (without signature verification)

Plans: ${VALID_PLANS.join(", ")}`)
}
