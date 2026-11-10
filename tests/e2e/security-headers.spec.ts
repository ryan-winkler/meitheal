import { expect, test } from "@playwright/test";

/**
 * Security Headers — Integration Test
 *
 * Validates that the middleware sets correct security headers for both
 * standalone and HA ingress modes. Uses live HTTP requests against
 * the running dev server.
 *
 * @domain auth
 * @bounded-context security
 */

const BASE = process.env.MEITHEAL_TEST_URL || "http://localhost:4321";
const needsServer = !process.env.MEITHEAL_TEST_URL;

test.describe("Security Headers (Standalone — no ingress)", () => {
  test.skip(needsServer, "Set MEITHEAL_TEST_URL to run security header specs");
  test("sets core OWASP security headers", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const headers = res.headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-xss-protection"] ?? "0").toBe("0");
    expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("sets CSP with self-only frame-ancestors in standalone mode", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const csp = res.headers()["content-security-policy"] ?? "";

    expect(csp).toContain("default-src 'self'");
    const scriptSources = csp.split(";")
      .find(directive => directive.trimStart().startsWith("script-src "))
      ?.trim().split(/\s+/) ?? [];
    expect(scriptSources).toContain("'self'");
    expect(scriptSources).not.toContain("data:");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test("sets connect-src to self-only in standalone mode", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const csp = res.headers()["content-security-policy"] ?? "";

    expect(csp).toContain("connect-src 'self'");
    // Standalone CSP must NOT include HA Supervisor origins.
    // Note: ws:/wss: may be present in dev mode for Vite HMR.
    expect(csp).not.toContain("http://supervisor");
  });

  test("includes request-id and response-time headers", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const headers = res.headers();

    expect(headers["x-request-id"]).toBeTruthy();
    expect(headers["x-response-time"]).toMatch(/^\d+ms$/);
  });

  test("includes rate-limit headers on API routes", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const headers = res.headers();

    expect(headers["x-ratelimit-limit"]).toBe("300");
    expect(headers["x-ratelimit-remaining"]).toBeTruthy();
    expect(headers["x-ratelimit-reset"]).toBeTruthy();
  });
});

test.describe("Security Headers (CSP policy correctness)", () => {
  test.skip(needsServer, "Set MEITHEAL_TEST_URL to run security header specs");
  test("self-hosted fonts: no external CDN in style-src or font-src", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const csp = res.headers()["content-security-policy"] ?? "";

    // Fonts are self-hosted via @fontsource — no external CDN allowed
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  test("allows data: and blob: in img-src for attachments", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const csp = res.headers()["content-security-policy"] ?? "";

    expect(csp).toContain("img-src 'self' data: blob:");
  });
});
