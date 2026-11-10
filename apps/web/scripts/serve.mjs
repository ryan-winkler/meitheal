/**
 * Ingress-safe server wrapper for Astro standalone.
 *
 * Solves TWO critical HA Ingress problems:
 *
 * 1. **Double-slash redirect loop**: HA Supervisor can send requests with
 *    double trailing slashes (e.g., //). Astro's internal normalizer issues
 *    a 301 redirect to "/", which escapes the ingress iframe and loads the
 *    HA Dashboard inside itself → infinite recursion.
 *
 * 2. **Missing X-Ingress-Path header**: Some HA Supervisor versions/configs
 *    do NOT inject the X-Ingress-Path header on proxied requests. Without it,
 *    the Astro middleware cannot rewrite HTML paths (href="/tasks", src="/_astro/...")
 *    to include the ingress prefix, so all links bypass the proxy → HA Dashboard
 *    loads instead of Meitheal.
 *
 * Fix: This wrapper creates the HTTP server ITSELF (ASTRO_NODE_AUTOSTART=disabled)
 * and normalizes req.url + injects X-Ingress-Path BEFORE Astro processes the request.
 * The ingress path is discovered at startup by run.sh via the Supervisor API
 * (GET /addons/self/info → data.ingress_url) and exported as INGRESS_PATH.
 *
 * Bounded context: auth (ingress)
 */

import http from "node:http";

// Prevent Astro standalone from auto-starting its own HTTP server.
process.env.ASTRO_NODE_AUTOSTART = "disabled";

// Server-private marker: only this wrapper overwrites the socket-peer header.
// Astro's clientAddress may contain X-Forwarded-For and is not an auth boundary.
globalThis[Symbol.for("meitheal.trusted-socket-peer-header")] = true;

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

// Ingress path discovered at startup by run.sh from Supervisor API.
// e.g., "/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo"
const INGRESS_PATH = (process.env.INGRESS_PATH ?? "").replace(/\/+$/, "") || "";

if (INGRESS_PATH) {
  console.log(`Ingress path injected: ${INGRESS_PATH}`);
} else {
  console.log("No INGRESS_PATH set — running in standalone mode (no header injection)");
}

// Dynamically import the Astro entry to get the handler
const { handler } = await import("../dist/server/entry.mjs");

const server = http.createServer((req, res) => {
  // Always replace caller input with the immediate socket peer, including an
  // empty value when unavailable. This header is never trusted in bare Astro.
  req.headers["x-meitheal-socket-peer"] = req.socket.remoteAddress ?? "";
  // 1. Normalize URL: collapse duplicate slashes (// → /)
  //    Prevents Astro's collapseDuplicateTrailingSlashes from issuing
  //    301 redirects that escape the ingress iframe.
  if (req.url) {
    const [pathPart, ...queryParts] = req.url.split("?");
    const queryPart = queryParts.join("?");
    const normalized = pathPart.replace(/\/\/+/g, "/");
    req.url = queryPart ? `${normalized}?${queryPart}` : normalized;
  }

  // 2. Inject X-Ingress-Path header if discovered at startup.
  //    This ensures the Astro middleware can rewrite all HTML paths
  //    (href, src, action, CSS url()) to include the ingress prefix,
  //    even when HA Supervisor doesn't send the header itself.
  if (INGRESS_PATH && !req.headers["x-ingress-path"]) {
    req.headers["x-ingress-path"] = INGRESS_PATH;
  }

  handler(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Meitheal server listening on http://${HOST}:${PORT}`);
});
