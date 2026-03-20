# Phase 15: Hierarchy Architecture Overhaul — Summary

**Synthesized:** 2026-03-20
**Inputs:** 15-CONTEXT.md, 15-RESEARCH.md, Persona Loop (3 panels, 15 accepted)
**Confidence:** HIGH

---

## What We're Building

Consolidate Meitheal's 11-item flat sidebar into a **6-item focused navigation** with three parent pages housing sub-views behind tab bars.

### Before
```
Dashboard → Kanban → Table → Today → Upcoming → Calendar → Gamification → Habits → Projects → Goals → Eisenhower
(11 items + AREAS section)
```

### After
```
Dashboard → Today → Upcoming → Tasks → Progress & Growth → Planning
(6 items + AREAS tree with "Every Day" pinned at top)
```

| Parent Page | Sub-Views | Route Pattern |
|-------------|-----------|---------------|
| **Tasks** | Kanban · Calendar · Table · Gantt | `/tasks#kanban` |
| **Progress & Growth** | Routines · Goals · Achievements | `/progress#routines` |
| **Planning** | Eisenhower · Triage · RICE | `/planning#eisenhower` |

### Area & Project Detail Pages (Per-Instance Sub-Menus)

| Detail Page | Sub-Views | Route Pattern |
|-------------|-----------|---------------|
| **Area Detail** | Overview · Goals · Projects · Settings | `/areas/[id]#overview` |
| **Project Detail** | Overview · Tasks · Fields · Settings | `/projects/[id]#overview` |

These are per-instance pages (each area/project has its own). Sub-menus use the same hash-based section pattern as parent pages but are page-local rather than registered in `parent-page-registry.ts`.

---

## Architecture Decisions (Validated)

### Pattern: UnifiedBar + Hash Routing (PROVEN)
- Settings page already implements this pattern (578 lines, 8 shell rollout phases)
- All sections render server-side (Astro SSR), CSS toggles visibility
- Hash changes handled by controller, no page reload
- Ingress-safe: hash fragments never leave the iframe

### Shared ParentPageShell Component (NEW)
- Eliminates Settings-style boilerplate duplication across 3 pages
- Props: `sections`, `title`, `icon`, `searchScope`
- Handles UnifiedBar, hash routing, section show/hide, controller lifecycle

### Pinnable Sub-Menus
- Extend `sidebar_config` settings with `pinnedSubMenus: Record<string, boolean>`
- Hidden by default, configurable in Settings
- Pinned items appear as indented children in expanded sidebar
- Links directly to `/tasks#kanban` (shortcut, not separate page)

### Custom Gantt (EVOLVE, DON'T REPLACE)
- `gantt.astro` (392 lines) already works: CSS Grid, design tokens, epic grouping
- No external dependencies — license-clean for AGPL-3.0 + Commercial
- Extract to `gantt-controller.ts` for modularity
- Enhancement roadmap: drag-drop → view modes → dependency arrows → a11y

---

## Schema Changes

| Table | Change | Purpose |
|-------|--------|---------|
| `projects` | Add `is_default BOOLEAN DEFAULT false` | "Every Day" protection |
| `tasks` | Add `goal_id TEXT REFERENCES goals(id)` | Direct goal→task linking |
| `tasks` | Add `calendar_event` to `task_kind` | Calendar events as tasks |
| `routine_templates` | **NEW TABLE** | Schedule, frequency, streak tracking |
| `routine_templates` | `last_spawned_at DATETIME` | Idempotent spawn prevention |
| `routine_instances` | Add unique constraint `(template_id, spawned_for_date)` | Double-spawn prevention |

---

## Key Persona Recommendations (Integrated)

### Must-Haves (P0)
- **Every Day as default capture target** — quick-add without categorization (ADHD)
- **Idempotent routine spawning** — unique constraint prevents double-spawn (Reliability)
- **HA ingress Tier 2 verification** — no ship without devcontainer testing (HA-native)
- **6-item sidebar** — working memory sweet spot for ADHD (Focus)
- **Astro SSR-first rendering** — all tabs in DOM, CSS toggles visibility (Astro-native)
- **Area & Project detail sub-menus** — Areas need index + detail pages; Projects need sub-menu tabs (Overview, Tasks, Fields, Settings). No orphan pages without navigation context.

### Should-Haves (P1)
- **Routine auto-spawn on page load** — no manual intervention (ADHD/Automation)
- **Hierarchy breadcrumb** — Area → Goal → Project → Task in detail modal (ADHD/Context)
- **Daily routine check-in on Today page** — warm-up momentum builder (ADHD)
- **MCP manifest updates** — AI agents can navigate sub-views (AI-native)
- **PARENT_PAGE_ROUTES constant** — single source of truth for route mapping (Architecture)

### Nice-to-Haves (P2)
- **Gantt ARIA grid roles** — keyboard navigation, screen reader support (a11y)
- **Gantt controller extraction** — modular, testable, lazy-init (Architecture)
- **Default project API guards** — `is_default` protected server-side (Security)

---

## Native-First Constraints

| Constraint | How Phase 15 Respects It |
|-----------|--------------------------|
| **Astro-native** | All SSR, hash routing, zero-JS default, UnifiedBar component |
| **HA-native** | Ingress-safe hash routing, Tier 2 verification required, ingress rewrite compat |
| **AI/MCP-native** | MCP manifest updated with sub-views, agents can navigate parent pages |

---

## Verification Requirements

| Tier | What | When |
|------|------|------|
| 🔧 Tier 1 (`npm run dev`) | Tab switching, section rendering, sidebar consolidation | Every wave |
| 🏠 Tier 2 (devcontainer) | Ingress hash routing, redirect compat, API guards | Before ship |
| 🌐 Tier 3 (production HA) | Full E2E with real data, routine spawning | Final acceptance |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Ingress redirect loops from old routes | Medium | High | Use `Astro.redirect()` which respects middleware |
| Routine double-spawn | High (without fix) | Medium | Unique constraint + `last_spawned_at` |
| Pinned sub-menu confusion (duplicate nav) | Low | Medium | Clear visual hierarchy — pinned items indented |
| Gantt sizing in hidden tab | Medium | Low | Initialize Gantt controller only on hash activation |

---

*Ready for plan-phase → PLAN.md*
