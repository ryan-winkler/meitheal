# GSD Plan & Tasks — Modal UI/UX Passthrough

> Synthesized from Panel 1 (Frontier) + Panel 2 (ADHD/Productivity)
> 8 accepted tasks, 1 deferred

## Tasks

| # | Task | Source | Effort |
|---|------|--------|--------|
| T1 | Remove stale `.modal-overlay.open` from `prefers-reduced-motion` block in `_modal.css:113` | Platform Architect | 1 |
| T2 | Replace `style="display:none"` on `#td-loaded-content` with class toggle | OSS Integrations | 1 |
| T3 | Add `<noscript>` CSS fallback for mobile sidebar toggle | Reliability Engineer | 2 |
| T4 | Guard `#td-desc-saved` timeout with modal abort signal | Security Engineer | 1 |
| T5 | Replace ➕ emoji in checklist "Add Item" button with SVG icon | Product Architect | 1 |
| T6 | Remove stale `.animate-slide-in` rule from `_modal.css:244` | Workflow Coach | 1 |
| T7 | Add Cmd/Ctrl+S keyboard shortcut in description edit mode | Execution Coach | 2 |
| T8 | Rename mobile sidebar toggle label from "Properties" to "Details" | Knowledge Coach | 1 |
| T9 | Add `event.target` check to prevent click-to-edit on markdown links in description preview | Automation Coach | 2 |

## Deferred

| # | Task | Source | Reason |
|---|------|--------|--------|
| D1 | Auto-expand sidebar for active tasks on mobile | Focus Optimizer | Effort/risk exceeds cleanup pass scope |

## Execution Order

1. T1, T2, T5, T6, T8 — trivial cleanup (parallel)
2. T4 — timeout guard
3. T3 — noscript fallback
4. T7 — Cmd+S shortcut
5. T9 — click handler fix
