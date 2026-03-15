# Frontier Panel - Phase 09 Iteration 01

## Objective
Search hub upgrade for Astro-native, Home Assistant-native task discovery and navigation.

## Recommendations

| Persona | Recommendation | Impact | Effort | Risk | Decision |
|---|---|---:|---:|---:|---|
| Product Architect | Replace split topbar search and command palette with one shared search hub | 5 | 3 | 2 | Accept |
| Astro Native Reviewer | Keep the search UI Astro-first with shared components and vanilla TS controllers | 5 | 2 | 2 | Accept |
| HA UX Reviewer | Make every search navigation/result ingress-safe and expose HA-aware actions in the same hub | 5 | 2 | 2 | Accept |
| Domain Reviewer | Introduce a dedicated search domain and `/api/search` instead of more inline layout logic | 5 | 2 | 2 | Accept |
| Reliability Engineer | Route HA search service, LLM API, and MCP through the same upgraded backend contract | 5 | 2 | 3 | Accept |

## Accepted Direction
- Astro-first overlay + controller instead of SPA client-state search
- Dedicated `/api/search` orchestration with shared repository-backed sources
- One launch surface and one backend contract across UI, HA service, LLM API, and MCP
