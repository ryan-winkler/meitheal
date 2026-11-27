/**
 * Dynamic Web App Manifest — Ingress-Aware
 *
 * Generates manifest.webmanifest with scope and start_url
 * prefixed by the HA ingress path when accessed through Supervisor.
 *
 * Why dynamic: The manifest must declare a `scope` that matches
 * the SW registration scope. Behind HA ingress, all URLs are
 * prefixed with /api/hassio_ingress/{token}/ — a permanent,
 * per-installation path. This endpoint reads X-Ingress-Path
 * from the request headers (injected by Supervisor) and builds
 * the manifest accordingly.
 *
 * Bounded context: pwa / auth (ingress)
 *
 * @kcs Ingress token is permanent per-installation — confirmed
 * by HA Supervisor team (issue #6605).
 */
import type { APIRoute } from "astro"
import { buildPwaManifest } from "../lib/pwa-manifest-builder"

export const GET: APIRoute = ({ locals, url }) => {
  const ingressPath = locals.ingressPath ?? ""
  const kind = url.searchParams.get("kind")
  const manifest = buildPwaManifest(ingressPath, kind)

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Vary": "X-Ingress-Path",
    },
  })
}

