import { expect, test } from "@playwright/test";
import { buildSecurityHeaders, isCsrfAllowed } from "../../apps/web/src/domains/auth/ingress-policy";

test("security headers allow framing when behindIngress=true", () => {
  const headers = buildSecurityHeaders(true, false);
  expect(headers["X-Frame-Options"]).toBeUndefined();
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors *");
  expect(headers["Content-Security-Policy"]).toContain(
    "connect-src 'self' ws: wss: http://supervisor http://supervisor:*"
  );
});

test("security headers enforce same-origin framing when behindIngress=false", () => {
  const headers = buildSecurityHeaders(false, false);
  expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
});

test("csrf validation allows HA ingress requests even with host mismatch", () => {
  const allowed = isCsrfAllowed({
    behindIngress: true,
    isDev: false,
    origin: "http://ha.internal:8123",
    referer: null,
    host: "addon:3000",
  });
  expect(allowed).toBeTruthy();
});

test("csrf validation blocks cross-origin mutating requests outside ingress", () => {
  const allowed = isCsrfAllowed({
    behindIngress: false,
    isDev: false,
    origin: "https://evil.example",
    referer: null,
    host: "meitheal.local",
  });
  expect(allowed).toBeFalsy();
});

test("csrf validation rejects requests with no origin and no referer", () => {
  // Correct behavior: missing both headers indicates a stripped-headers attack
  // or non-browser client. The policy correctly rejects these in standalone mode.
  const allowed = isCsrfAllowed({
    behindIngress: false,
    isDev: false,
    origin: null,
    referer: null,
    host: "meitheal.local",
  });
  expect(allowed).toBeFalsy();
});
