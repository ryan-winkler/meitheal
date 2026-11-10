import type { APIRoute } from "astro";

export const GET: APIRoute = ({ url }) => {
  const text = `# Meitheal Hub — Robots
# HA addon context: crawlers shouldn't reach this, but belt-and-braces.

User-agent: *
Allow: /
Allow: /api/health
Disallow: /api/
Disallow: /settings

Sitemap: ${url.origin}/sitemap.xml
`.trim();

  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
};

