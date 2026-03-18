# Panel 5: UX & Design Specialists — Human-Agent DDD Core

**Objective:** How should the new hierarchy model look and feel in the Meitheal UI?

---

## 41. Information Architecture Specialist

**Focus:** How should the new hierarchy be structured in the navigation?

**Recommendation:** The sidebar should use a collapsible tree with these levels:
```
📁 Area: Personal
  🎯 Goal: Get Healthier
    📋 Project: Gym Routine
    📋 Project: Meal Prep
  🎯 Goal: Manage Finances
    📋 Project: Q2 Budget
📁 Area: Work
  🎯 Goal: Ship v1.0
    📋 Project: Backend API
    📋 Project: Frontend UI
```

Each Project opens as a board (existing kanban/table/today views). Goals show a summary card with progress. Areas are collapsible group headers. This replaces the current flat board list in the sidebar.

- **Impact:** 5 — the sidebar is the main navigation surface
- **Effort:** 4 — sidebar tree component, data fetching, state management
- **Risk:** 3 — sidebar is used on every page, ingress-safe tree navigation is tricky

**Success Criterion:** Sidebar shows Area→Goal→Project tree. Clicking a Project loads its board. Collapsing an Area hides all its Goals and Projects.

**Decision:** ⏸️ Defer — Phase 04.2 (UI), not 04.1 (Schema).

---

## 42. Micro-Interaction Designer *(Custom)*

**Focus:** What animations and transitions support the new model?

**Recommendation:** For bot handoff, add subtle visual cues:
- Task card pulse animation (blue glow) when a bot claims it
- "🤖 Working..." badge overlay on locked task cards
- Slide-in proposal diff view when a bot submits a proposal
- Confetti micro-animation when a bot proposal is accepted
- Progress ring animation on goal/project cards as tasks complete

These animations should be CSS-only (no JavaScript animation libraries) and respect `prefers-reduced-motion`.

- **Impact:** 3 — polish, not critical
- **Effort:** 3 — CSS animations, `prefers-reduced-motion` media query
- **Risk:** 1 — purely cosmetic

**Success Criterion:** Bot claim shows blue pulse. `prefers-reduced-motion: reduce` disables all animations.

**Decision:** ⏸️ Defer — Phase 04.2 (UI).

---

## 43. Accessibility Expert *(Custom)*

**Focus:** Is the new model accessible?

**Recommendation:** The hierarchy tree must support:
- `role="tree"`, `role="treeitem"`, `aria-expanded` for collapsible nodes
- Keyboard navigation: arrow keys to move between nodes, Enter to expand/collapse, Space to select
- Screen reader labels: "Area: Personal, 2 goals. Goal: Get Healthier, 3 projects. Project: Gym Routine, 12 tasks."
- Bot handoff badges must have `aria-label="Bot is working on this task"` not just a 🤖 emoji

- **Impact:** 4 — accessibility is a production requirement
- **Effort:** 2 — ARIA attributes on existing components
- **Risk:** 1 — additive, no visual changes

**Success Criterion:** Sidebar tree passes axe-core automated audit. Screen reader announces hierarchy correctly.

**Decision:** ⏸️ Defer — Phase 04.2 (UI), but MUST be included in UI implementation.

---

## 44. Mobile/PWA UX Specialist *(Custom)*

**Focus:** How does the hierarchy work on mobile?

**Recommendation:** On mobile (< 768px), the sidebar tree should be replaced with a **breadcrumb-based drill-down**:
1. Tap hamburger → see Areas (full width cards, not a tree)
2. Tap an Area → see its Goals
3. Tap a Goal → see its Projects
4. Tap a Project → see the board

The "back" button navigates up the hierarchy. Current project context stays in the breadcrumb bar. This avoids the complexity of a tree component on small screens.

- **Impact:** 4 — mobile is a primary use case for HA companion app
- **Effort:** 3 — breadcrumb component, drill-down navigation
- **Risk:** 2 — needs careful ingress path handling

**Success Criterion:** On mobile viewport, navigation is card-based drill-down, not tree. Breadcrumb shows current position.

**Decision:** ⏸️ Defer — Phase 04.2 (UI).

---

## 45. Dark Mode Designer *(Custom)*

**Focus:** How do new elements look in dark mode?

**Recommendation:** New elements (goal cards, project progress, bot activity section) must use CSS custom properties from the existing design token system. Do NOT introduce new colors — use the existing palette. Specifically:
- Bot lock badge: `--accent-warning` (amber/orange)
- Goal progress ring: `--accent-success` (green)
- Area headers: `--surface-secondary` background
- Proposal diff: use existing `--code-bg` and `--diff-add`/`--diff-remove`

- **Impact:** 2 — themes already handled well
- **Effort:** 1 — use existing CSS variables
- **Risk:** 1 — no new tokens needed

**Success Criterion:** All new elements render correctly in both light and dark themes using existing CSS custom properties only.

**Decision:** ✅ Accept — design constraint, no implementation needed.

---

## 46. Settings Integration Designer *(Custom)*

**Focus:** What settings does the new model need?

**Recommendation:** Add minimal settings for Phase 04.1:
1. **Bot Settings** (in "Automation & AI" section): Toggle for "Allow bot proposals" (default: on), "Auto-accept safe changes" (default: off), "Lock timeout minutes" (default: 5)
2. NO settings for Areas/Goals/Projects — these are configured in the sidebar tree, not Settings

Do NOT add a "Task Kind" selector to Settings — task kinds are assigned per-task.

- **Impact:** 3 — bot settings are needed before bots can be enabled
- **Effort:** 2 — 3 toggles in existing settings section
- **Risk:** 1 — additive settings, using existing infrastructure

**Success Criterion:** Settings shows bot controls. `GET /api/settings` returns bot configuration values.

**Decision:** ✅ Accept

---

## 47. Search Integration Designer *(Custom)*

**Focus:** How does universal search handle the new model?

**Recommendation:** Extend the search hub to search across all entity types:
- Tasks: existing search (unchanged)
- Goals: searchable by title, area name
- Projects: searchable by title, goal name
- Routines: searchable by template name

Search results show entity type as a badge: `[Task]`, `[Goal]`, `[Project]`, `[Routine]`. Clicking a goal/project result navigates to it in the sidebar.

- **Impact:** 3 — search should find everything
- **Effort:** 3 — extend search catalog and API
- **Risk:** 2 — touches shared search infrastructure

**Success Criterion:** Searching for "fitness" finds both a Goal "Get Healthier" and a Project "Gym Routine" and a Task "Buy gym membership".

**Decision:** ⏸️ Defer — Phase 04.2 or search polish phase.

---

## 48. Onboarding Experience Designer *(Custom)*

**Focus:** How does a new user understand the hierarchy?

**Recommendation:** First-time experience should NOT show the full hierarchy. Progressive disclosure:
1. **First launch:** Show only the default project board with tasks. Sidebar shows a flat board list (existing behavior).
2. **After 10 tasks:** Show a subtle "Organize with Projects" callout. Clicking it explains the Area→Goal→Project model.
3. **After first Goal:** Sidebar switches to tree view.
4. **Bot features:** Only appear after the user enables them in Settings.

- **Impact:** 4 — prevents information overload for new users
- **Effort:** 3 — conditional rendering based on entity counts
- **Risk:** 1 — additive, progressively disclosed

**Success Criterion:** Fresh install looks identical to current Meitheal. No goals/areas visible until user creates one.

**Decision:** ⏸️ Defer — Phase 04.2 (UI), but critical for launch acceptance.

---

## 49. HA Dashboard Card Designer *(Custom)*

**Focus:** What HA dashboard cards should Meitheal expose?

**Recommendation:** Design these Meitheal HA dashboard cards:
1. **Goal Progress Card** — shows goal name, progress ring, linked project count
2. **Daily Summary Card** — tasks completed/remaining, routines done, streak info
3. **Bot Activity Card** — recent bot proposals, acceptance rate

These cards use HA's custom card infrastructure (HACS or built-in). They query Meitheal's API for data. Implementation is a separate phase but the API contract should be designed now.

- **Impact:** 3 — HA dashboard is a premium integration point
- **Effort:** 4 — custom HA cards are a separate development effort
- **Risk:** 2 — HA card API is well-documented

**Success Criterion:** API endpoints exist that return goal progress, daily summary, and bot activity in card-friendly JSON format.

**Decision:** ⏸️ Defer — separate phase entirely, but define API contract in research phase.

---

## 50. Voice UX Designer *(Custom)*

**Focus:** How do voice commands work with the new hierarchy?

**Recommendation:** Map voice intent slots to the new model:
- "Add [item] to [project]" → create task in project
- "What's the progress on [goal]?" → query goal progress
- "Mark [routine] as done" → complete today's routine instance
- "Show my [area] goals" → query goals filtered by area
- "What is the bot working on?" → query tasks where handoff_state = 'claimed'

These map to existing HA conversation intents with Meitheal tool functions. The key design rule: **voice should never need to reference task_kind** — the system infers it. "Add milk to shopping" → creates a `shopping_item` task in the Shopping project.

- **Impact:** 4 — voice control is a key HA differentiator
- **Effort:** 3 — intent mapping + LLM tool declarations
- **Risk:** 2 — intent parsing depends on HA's Assist quality

**Success Criterion:** "Hey Google, add milk to my shopping list" creates a task with `task_kind: shopping_item` in the correct project.

**Decision:** ⏸️ Defer — depends on schema + MCP tools being stable.
