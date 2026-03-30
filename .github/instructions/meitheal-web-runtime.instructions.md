---
description: "Use when editing Meitheal Astro runtime, domain packages, settings, search, or integration code. Covers Astro-first architecture, DDD boundaries, ingress-safe behavior, and shared runtime patterns."
applyTo: "apps/web/**, packages/domain-*/**, packages/integration-core/**"
---

# Meitheal Web Runtime Rules

- Preserve Astro-first SSR architecture. Prefer official Astro integrations before custom infrastructure.
- Keep DDD bounded contexts intact. Cross-context imports must go through public package APIs, not deep imports.
- Never issue server-side redirects to bare `/` paths behind Home Assistant ingress.
- Do not wrap client-side `fetch()` with `apiUrl()` inside the web runtime. `Layout.astro` already prefixes fetches behind ingress.
- Always pass `AbortSignal` when registering long-lived client event listeners to avoid accumulation across navigations.
- For Settings work, treat `apps/web/src/lib/settings-registry.ts` as canonical and keep navigation hash-based and ingress-safe.
- For Search work, extend `apps/web/src/domains/search/` and shared search surfaces instead of introducing duplicate page-local registries or endpoints.
