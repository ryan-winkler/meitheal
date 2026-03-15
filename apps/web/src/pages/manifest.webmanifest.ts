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
import type { APIRoute } from "astro";
import { getIngressPath } from "@domains/auth/ingress";

const MANIFEST_BASE = {
  name: "Meitheal",
  short_name: "Meitheal",
  description: "Your homelab's execution layer — centralize tasks, automate coordination, get out of the way of life.",
  lang: "en",
  display: "standalone" as const,
  orientation: "any" as const,
  background_color: "#0f172a",
  theme_color: "#0f172a",
  categories: ["productivity", "utilities"],
  prefer_related_applications: false,
  icons: [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
  screenshots: [
    {
      src: "/pwa/screenshots/settings-desktop.png",
      sizes: "1440x1024",
      type: "image/png",
      form_factor: "wide",
      label: "Meitheal settings shell on desktop",
    },
    {
      src: "/pwa/screenshots/settings-mobile.png",
      sizes: "430x932",
      type: "image/png",
      form_factor: "narrow",
      label: "Meitheal settings shell on mobile",
    },
  ],
};

const SHORTCUTS = [
  {
    name: "Today",
    short_name: "Today",
    description: "Jump straight into today’s work",
    url: "/today",
  },
  {
    name: "Calendar",
    short_name: "Calendar",
    description: "Review scheduled work and due dates",
    url: "/calendar",
  },
  {
    name: "Settings",
    short_name: "Settings",
    description: "Open the Home Assistant-native settings shell",
    url: "/settings#app-pwa-settings",
  },
];

export const GET: APIRoute = ({ request }) => {
  const ingressPath = getIngressPath(request.headers, request.url) ?? "";

  // Prefix helper: prepend ingress path to absolute URLs
  const prefix = (path: string): string => `${ingressPath}${path}`;

  const manifest = {
    ...MANIFEST_BASE,
    // id is intentionally NOT prefixed: a stable ID prevents the browser
    // from treating each ingress token as a different PWA installation.
    id: "/",
    start_url: prefix("/"),
    scope: prefix("/"),
    icons: MANIFEST_BASE.icons.map((icon) => ({
      ...icon,
      src: prefix(icon.src),
    })),
    shortcuts: SHORTCUTS.map((s) => ({
      ...s,
      url: prefix(s.url),
      icons: [{ src: prefix("/icon-192.png"), sizes: "192x192" }],
    })),
    screenshots: MANIFEST_BASE.screenshots.map((s) => ({
      ...s,
      src: prefix(s.src),
    })),
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
