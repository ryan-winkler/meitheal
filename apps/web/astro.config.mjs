import { defineConfig, passthroughImageService } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { minify } from "terser";

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
  devToolbar: { enabled: false },
  image: { service: passthroughImageService() },
  integrations: [{
    name: "compact-server-output",
    hooks: {
      "astro:build:setup": ({ target, updateConfig }) => {
        if (target === "server") updateConfig({
          ssr: { noExternal: ["date-fns", "date-fns-tz", "zod", "yaml", "home-assistant-js-websocket", "parse5-html-rewriting-stream", "sanitize-html"] },
          build: { minify: "terser", terserOptions: { keep_fnames: true, keep_classnames: true } },
        })
      },
    },
  }, {
    name: "compact-client-assets",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const worker = new URL("sw.js", dir)
        const { code } = await minify(readFileSync(worker, "utf8"), {
          compress: { passes: 3, toplevel: true },
          mangle: { toplevel: true },
          format: { comments: "some" },
        })
        if (code) writeFileSync(worker, code)
        const astroDir = new URL("_astro/", dir)
        const jsFiles = readdirSync(astroDir).filter((name) => name.endsWith(".js"))
        await Promise.all(jsFiles.map(async (name) => {
          const target = new URL(name, astroDir)
          const source = readFileSync(target, "utf8")
          const result = await minify(source, {
            module: true,
            compress: { passes: 3 },
            mangle: true,
            format: { comments: false },
          })
          if (result.code && result.code.length < source.length) {
            writeFileSync(target, result.code)
          }
        }))
      },
    },
  }],
  compressHTML: true,
  // Class scoping matches attribute scoping specificity (0,1,0) while shrinking
  // scoped CSS selectors (~22 KB) and SSR HTML payloads with faster class lookup.
  scopedStyleStrategy: "class",
  prefetch: {
    defaultStrategy: "hover",
    prefetchAll: false,
  },
  security: {
    checkOrigin: false,
  },
  vite: {
    resolve: {
      alias: {
        "@lib": resolve(process.cwd(), "src/lib"),
        "@domains": resolve(process.cwd(), "src/domains"),
        "@i18n": resolve(process.cwd(), "src/i18n"),
      },
    },
    build: {
      cssMinify: "lightningcss",
    },
    server: {
      allowedHosts: true,
      hmr: false,
    },
    experimental: {
      renderBuiltUrl(_filename, { hostType, type }) {
        // Dynamic preloads must resolve from the script URL inside HA ingress.
        if (hostType === "js" && type === "asset") return { relative: true }
      },
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
      include: ["dompurify", "date-fns-tz", "sortablejs"],
    },
  },
});
