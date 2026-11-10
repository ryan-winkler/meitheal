import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Single source of truth for version ──────────────────────────────
// Read from meitheal-hub/config.yaml at build time. This value is
// injected into all Astro components via vite.define, the service
// worker via a generated version.json, and the health API at runtime.
function getVersion() {
  if (process.env.MEITHEAL_VERSION) return process.env.MEITHEAL_VERSION;
  try {
    const yaml = readFileSync(
      resolve(process.cwd(), "../../meitheal-hub/config.yaml"),
      "utf-8"
    );
    const match = yaml.match(/^version:\s*["']?([^"'\n]+)["']?/m);
    if (match?.[1]) return match[1];
  } catch { /* fallback */ }
  return "0.0.0-dev";
}

const MEITHEAL_VERSION = getVersion();

// Write version.json to public/ so the service worker can read it.
// This file is gitignored — it's regenerated on every build/dev start.
writeFileSync(
  resolve(process.cwd(), "public/version.json"),
  JSON.stringify({ version: MEITHEAL_VERSION, generatedAt: new Date().toISOString() })
);

export default defineConfig({
  site: process.env.SITE_URL || "http://localhost:3000",
  output: "server",
  trailingSlash: "never",
  adapter: node({ mode: "standalone" }),
  integrations: [{
    name: "compact-server-output",
    hooks: {
      "astro:build:setup": ({ target, updateConfig }) => {
        if (target === "server") updateConfig({ build: { minify: true }, ssr: { noExternal: ["sanitize-html"] } })
      },
    },
  }],
  compressHTML: true,
  prefetch: true,
  vite: {
    experimental: {
      renderBuiltUrl(_filename, { hostType, type }) {
        // Dynamic preloads must resolve from the script URL inside HA ingress.
        if (hostType === "js" && type === "asset") return { relative: true }
      },
    },
    ssr: {
      // Sharp must resolve its native binary from the target-platform install.
      external: ["sharp"],
      // Let the server build tree-shake date helpers used by Tasks.
      noExternal: ["date-fns", "date-fns-tz", "zod", "yaml", "home-assistant-js-websocket", "parse5-html-rewriting-stream"],
    },
    plugins: [
      // Tailwind CSS v4 — replaces @astrojs/tailwind integration
      tailwindcss(),
      // Fix font 404s in HA ingress: @fontsource CSS embeds absolute
      // url(/_astro/font.woff2) paths. Static CSS files bypass middleware
      // rewriting, so browsers resolve against HA root → 404.
      // Since fonts & CSS both live in _astro/, relative paths work.
      {
        name: "fontsource-relative-paths",
        enforce: "post",
        generateBundle(_, bundle) {
          for (const [, chunk] of Object.entries(bundle)) {
            if (chunk.type === "asset" && chunk.fileName.endsWith(".css")) {
              chunk.source = String(chunk.source).replace(
                /url\(\s*(["']?)\/_astro\//g,
                "url($1./"
              );
            }
          }
        },
      },
    ],
    define: {
      __MEITHEAL_ASTRO_FIRST__: true,
      __MEITHEAL_VERSION__: JSON.stringify(MEITHEAL_VERSION),
    },
    optimizeDeps: {
      // Pre-bundle dependencies that Vite discovers at runtime, preventing
      // "optimized dependencies changed. reloading" mid-session (causes 504 errors).
      include: [
        "marked",
      ],
    },
  },
});
