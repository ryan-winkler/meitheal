---
type: "Reference"
title: "Design engineering and UX principles"
description: "Visual, interaction and usability standards for Meitheal interfaces."
okf_version: "0.2"
---

# Design engineering and UX principles

This guide explains the visual, interaction, and usability standards for Meitheal. Use it with [DESIGN.md](../../DESIGN.md) and [Client-side patterns](client-side-patterns.md) when you build or review any interface change.

## Core frameworks

Meitheal applies six complementary disciplines together:

1. **Domain-Driven Design (DDD), DRY, and YAGNI**: Place every setting and control in its owning bounded context. Share one canonical state store between onboarding, settings, and live workspace controls (for example, `workspace-preferences.ts` for Quick Add vs Task Form and `domains/navigation/sidebar-menu.ts` for navigation items).
2. **Tabler UI and Icons**: Use the typed Tabler icon registry (`apps/web/src/generated/icon-registry.ts`), Tabler `nav-overflow` patterns, Tabler modal surfaces, and Tabler `ThemeSettings.astro` `96×64` inline SVG visual tiles.
3. **Gestalt Principles**:
   - **Common Region & Hierarchy**: Give peer capability groups equal top-level `SettingsPanelCard` surfaces rather than nesting peer groups inside disclosures.
   - **Proximity**: Use unified `20px` spacing between cards and field groups; avoid `0px` touching borders.
   - **Similarity**: Style peer actions identically (for example, matching `.btn.btn-secondary.btn-sm` buttons with icons).
   - **Figure-Ground**: Elevate floating popovers and docked editors with crisp borders, `var(--bg-card)` surfaces, and high `z-index` values (`240–260`) so sticky headers never clip them.
4. **Nielsen's 10 Usability Heuristics**:
   - Keep live previews explicit with Discard and Save controls.
   - Avoid duplicate trigger menus: clicking the profile card opens Edit Profile directly, while the Keyboard utility button on the right holds navigation, shortcut, and Settings tools.
   - Allow hiding *Settings* in navigation while keeping *Settings* permanently reachable in the Keyboard utility popover so users cannot lock themselves out.
   - Keep contextual `?` help dialogs on non-obvious controls and self-service error alerts on forms.
5. **Interaction Craft (`emil-design-eng`) and Continuous Taste (`learn-taste`)**:
   - Animate only when motion clarifies spatial cause-and-effect.
   - Use crisp ease-out transitions (`cubic-bezier(0.23, 1, 0.32, 1)`), subtle `:active` press states (`scale(0.97–0.98)`), origin-aware popovers, and strict `@media (prefers-reduced-motion: reduce)` fallbacks.
   - Record recurring UI corrections in [DESIGN.md](../../DESIGN.md) as **Before / After / Why** entries so design taste compounds across contributors and agents.
6. **User Mastery (Kathy Sierra) & OWASP Security**:
   - Make household workflows effortless (one-click view pinning for `Kanban`, `Calendar`, `Timeline`, and `Table` across Sidebar and Top Nav; local-first self-hosted fonts; WCAG AA accent contrast).
   - Enforce auth/scope checks before reading untrusted request bodies, validate URLs (`https://`, `http://`, `/`), and render user strings via safe DOM text APIs (`textContent`).

## Verification checklist for UI PRs

- Peer cards use equal top-level hierarchy and uniform `20px` spacing.
- No duplicate menus or redundant triggers appear in navigation chrome.
- Navigation editing and task view pinning work in Sidebar (Expanded, Folded, Hover), Top Navigation (`nav-overflow`), and Mobile (`<= 768px`).
- All visual tokens (theme, accent, avatar contrast, self-hosted fonts) render locally with zero external font calls and pass WCAG AA contrast.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:d917afa0adf725f3368964e034c0217c6874205853e53c76513d4f90484c66db -->

- `pnpm --filter @meitheal/web perf:budget` stays within `apps/web/scripts/perf-budget-baseline.json`.

<!-- /coderabbit-ai-generated:v1 -->
