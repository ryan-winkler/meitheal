# Phase 29: GSD Plan & Tasks — Synthesized from Persona Panels

**Date:** 2026-03-23
**Source:** Panel 1 (Frontier) + Panel 2 (ADHD/Productivity)
**Accepted:** 10 of 10 recommendations

---

## Wave 1: Foundation (Quick Wins)

| # | Task | Source | I/E/R | GSD Command |
|---|------|--------|-------|-------------|
| T1 | Create `btn-icon` + `btn-press` CSS utility class with `:active` scale, `cursor: pointer`, `focus-visible` | Workflow Coach | 4/2/1 | execute-phase |
| T2 | Apply `btn-icon` to ≥30 icon-only buttons across layout + task components | Product Architect + Workflow Coach | 3/2/1 | execute-phase |
| T3 | Create `docs/kcs/memory-safety-patterns.md` with 3 patterns, 3 examples, 3 anti-patterns | Knowledge Coach | 3/1/1 | execute-phase |
| T4 | Replace 5 `transition: all` with explicit property lists | Codebase metric | 2/1/1 | execute-phase |

## Wave 2: Reliability & Safety

| # | Task | Source | I/E/R | GSD Command |
|---|------|--------|-------|-------------|
| T5 | Add global `window.onerror` + `unhandledrejection` handler with toast + logger | Reliability Engineer | 4/2/2 | execute-phase |
| T6 | Wrap top 5 `pageLifecycle.onPageLoad` callbacks in try/catch with error toast | Reliability Engineer | 4/2/2 | execute-phase |
| T7 | Audit + replace top 5 dangerous `innerHTML` assignments with user data | Security Engineer | 4/2/2 | execute-phase |

## Wave 3: Memory Migration (Scoped — top 5 controllers)

| # | Task | Source | I/E/R | GSD Command |
|---|------|--------|-------|-------------|
| T8 | Migrate `kanban-controller.ts` to `managedListeners` / signal pattern | Platform Architect + Focus Optimizer | 5/3/2 | execute-phase |
| T9 | Migrate `table-controller.ts` to signal pattern | Platform Architect | 5/3/2 | execute-phase |
| T10 | Migrate `sidebar-controller.ts` to signal pattern | Platform Architect | 5/3/2 | execute-phase |
| T11 | Migrate `today-controller.ts` remaining gaps to signal pattern | Platform Architect | 5/2/2 | execute-phase |
| T12 | Migrate `timeline-controller.ts` to signal pattern | Platform Architect | 5/3/2 | execute-phase |

## Wave 4: Enforcement & Automation

| # | Task | Source | I/E/R | GSD Command |
|---|------|--------|-------|-------------|
| T13 | Create `scripts/health-check.mjs` for listener/innerHTML counts | Automation Coach | 3/2/1 | execute-phase |
| T14 | innerHTML → template conversion for top 5 render paths | OSS Integrations | 4/3/3 | execute-phase |

## Deferred to Phase 30

- ESLint `no-restricted-syntax` for addEventListener without signal (Execution Coach — deferred: needs broad fix first)
- Remaining 300+ addEventListener migrations beyond top 5 controllers
- Remaining 260+ aria-label gaps beyond the 30 targeted in T2
- Remaining 280+ inline styles beyond targeted cleanups

---

*Synthesized: 2026-03-23 | Phase 29 Iteration 01*
