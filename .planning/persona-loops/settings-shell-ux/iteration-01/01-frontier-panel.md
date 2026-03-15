# Frontier Panel - Settings Shell UX Iteration 01

## Objective
Make the top Settings summary strip behave like first-class navigation, reduce duplication in the shell configuration, and sharpen clarity so the page feels intentionally navigable on desktop, mobile, Home Assistant ingress, and PWA surfaces.

## 50-Perspective Audit Coverage
This iteration covers 20 frontier UI/UX lenses here, 15 ADHD/productivity lenses in `02-adhd-productivity-panel.md`, and 15 optimization/re-review lenses in `05-optimization-panel.md`.

## Recommendations

| Persona Lens | Recommendation | Impact | Effort | Risk | Decision |
|---|---|---:|---:|---:|---|
| Norman-style affordance lens | Make summary cards clickable because they already read as navigation | 5 | 1 | 1 | Accept |
| Nielsen heuristic lens | Match appearance to behavior; avoid “looks tappable, does nothing” | 5 | 1 | 1 | Accept |
| Rams simplification lens | Remove duplicated summary copy from page markup and centralize in the registry | 4 | 2 | 1 | Accept |
| Krug scanability lens | Add a clearer “Open” affordance on each summary card | 4 | 1 | 1 | Accept |
| Wroblewski mobile-first lens | Preserve the same jump behavior between summary cards and mobile rail | 4 | 2 | 1 | Accept |
| Astro-native reviewer | Keep the shell controller centralized; do not add more inline listeners | 5 | 1 | 1 | Accept |
| Home Assistant-native reviewer | Keep all jumps hash-based so ingress and companion scopes remain safe | 5 | 1 | 1 | Accept |
| PWA reliability lens | Make summary and rail navigation behave identically offline and after reload | 4 | 2 | 1 | Accept |
| Interaction systems lens | Sync active state between summary cards, rail links, and scroll position | 5 | 2 | 2 | Accept |
| Information architecture lens | Use the section registry as the single source for summary titles/details | 4 | 2 | 1 | Accept |
| Search/findability lens | Clear the search-muted state when the user intentionally jumps elsewhere | 5 | 1 | 1 | Accept |
| Accessibility keyboard lens | Use anchors rather than click-only divs so keyboard users get native behavior | 5 | 1 | 1 | Accept |
| Visual systems lens | Add icon, hover, focus, and active treatment so the strip feels purposeful | 4 | 2 | 1 | Accept |
| Trust/feedback lens | Reflect live status in the summary card detail and the rail badge together | 4 | 2 | 1 | Accept |
| Competitive parity lens | Treat the top strip as a quick-jump dashboard, not static ornamentation | 4 | 2 | 1 | Accept |
| Deep-linking lens | Resolve active state from hash targets even when linking to nested fields | 5 | 2 | 2 | Accept |
| Safety lens | Keep Danger Zone visually actionable but clearly distinct from normal controls | 3 | 2 | 1 | Defer |
| Density management lens | Avoid turning the summary strip into a second crowded sidebar | 3 | 2 | 2 | Accept |
| Motion restraint lens | Use subtle hover/active elevation instead of heavy animation | 3 | 1 | 1 | Accept |
| Duplication audit lens | Remove hardcoded per-card copy from `settings.astro` | 5 | 2 | 1 | Accept |

## Accepted Direction
- Convert the top strip from decorative cards into accessible hash-link quick jumps.
- Centralize summary titles/details in `settings-registry.ts`.
- Keep active state synchronized across summary strip, rail nav, scroll position, and deep links.
- Reset search-muted sections when a user intentionally jumps via summary or rail navigation.
- Preserve ingress-safe behavior and companion/PWA compatibility.
