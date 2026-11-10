import { test, expect } from "@playwright/test";
import {
  verifyLicenseKey,
  verifyLicenseKeyWithPublicKey,
} from "../../packages/domain-auth/src/index";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

const TEST_KEY_PAIR = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const TEST_PUBLIC_KEY_PEM = TEST_KEY_PAIR.publicKey;
const TEST_PRIVATE_KEY = createPrivateKey(TEST_KEY_PAIR.privateKey);

const WRONG_KEY_PAIR = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const WRONG_PRIVATE_KEY = createPrivateKey(WRONG_KEY_PAIR.privateKey);

/** Create a compact EdDSA JWT using an ephemeral test-only key. */
function createTestJWT(
  payload: Record<string, unknown>,
  privateKey: KeyObject = TEST_PRIVATE_KEY,
): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

test.describe("License Key Verification", () => {
  test("grace mode: no key returns valid with plan=none", () => {
    const result = verifyLicenseKey(undefined);
    expect(result.valid).toBe(true);
    expect(result.plan).toBe("none");
    if (result.valid && "grace" in result) {
      expect(result.grace).toBe(true);
    }
  });

  test("grace mode: empty string returns valid with plan=none", () => {
    const result = verifyLicenseKey("");
    expect(result.valid).toBe(true);
    expect(result.plan).toBe("none");
  });

  test("grace mode: whitespace-only returns valid with plan=none", () => {
    const result = verifyLicenseKey("   ");
    expect(result.valid).toBe(true);
    expect(result.plan).toBe("none");
  });

  test("invalid format: random string returns invalid", () => {
    const result = verifyLicenseKey("not-a-jwt");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  test("invalid format: two-part token returns invalid", () => {
    const result = verifyLicenseKey("part1.part2");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  test("valid key: accepts a properly signed token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT({
      iss: "meitheal",
      sub: "test@example.com",
      plan: "personal",
      iat: now,
      exp: now + 86400,
    });

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(true);
    if (result.valid && "email" in result) {
      expect(result.plan).toBe("personal");
      expect(result.email).toBe("test@example.com");
      expect(result.expiresAt).toBeTruthy();
    }
  });

  test("production verifier does not trust the ephemeral test key", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT({
      iss: "meitheal",
      sub: "test@example.com",
      plan: "personal",
      iat: now,
      exp: now + 86400,
    });

    const result = verifyLicenseKey(token);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  test("valid key: no-expiry token is valid", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT({
      iss: "meitheal",
      sub: "forever@example.com",
      plan: "household",
      iat: now,
    });

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(true);
    if (result.valid && "email" in result) {
      expect(result.plan).toBe("household");
      expect(result.expiresAt).toBeNull();
    }
  });

  test("expired key: returns invalid with reason=expired", () => {
    const pastTime = Math.floor(Date.now() / 1000) - 86400;
    const token = createTestJWT({
      iss: "meitheal",
      sub: "expired@example.com",
      plan: "personal",
      iat: pastTime - 86400,
      exp: pastTime,
    });

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("expired");
    }
  });

  test("wrong key: token signed with different key returns invalid_signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT(
      {
        iss: "meitheal",
        sub: "hacker@example.com",
        plan: "commercial",
        iat: now,
        exp: now + 86400,
      },
      WRONG_PRIVATE_KEY,
    );

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  test("wrong issuer: returns invalid_issuer", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT({
      iss: "not-meitheal",
      sub: "test@example.com",
      plan: "personal",
      iat: now,
      exp: now + 86400,
    });

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_issuer");
    }
  });

  test("commercial plan: correctly identifies commercial license", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createTestJWT({
      iss: "meitheal",
      sub: "business@corp.com",
      plan: "commercial",
      iat: now,
      exp: now + 31536000,
    });

    const result = verifyLicenseKeyWithPublicKey(token, TEST_PUBLIC_KEY_PEM);
    expect(result.valid).toBe(true);
    if (result.valid && "email" in result) {
      expect(result.plan).toBe("commercial");
    }
  });
});
