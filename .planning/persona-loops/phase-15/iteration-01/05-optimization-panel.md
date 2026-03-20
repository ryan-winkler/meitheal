# Panel 3: Optimization Review

**Objective:** Hierarchy Architecture Overhaul — three parent pages, pinnable sub-menus, routine templates, Gantt
**Phase:** 15 · **Iteration:** 01

---

## 1. Performance Engineer

**Recommendation:** Extract the existing `gantt.astro` inline Gantt rendering logic into a `lib/gantt-renderer.ts` module with a controller pattern, so the Gantt component can be lazy-initialized only when the #gantt tab is active in the Tasks parent page.

**Rationale:** Gantt currently renders 35 days × N tasks server-side into HTML. Inside the Tasks parent page, this HTML ships even when the user opens #kanban. Extracting to a controller means the Gantt section can be rendered server-side (Astro SSR) but the heavy CSS Grid recalculation only triggers when visible. This also makes the Gantt code testable and extensible per user's modular/extensible requirement.

**Success Criterion:** Gantt controller initializes only when `#gantt` hash is active. Moving from #kanban → #gantt shows content without page reload.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 3 | 2 | **Accept** |

---

## 2. Accessibility Specialist

**Recommendation:** Add `role="grid"`, `aria-colcount`, `aria-rowcount`, and keyboard navigation (arrow keys to move between tasks/days) to the Gantt view. Currently it's a flat div grid with no semantic structure.

**Rationale:** The Gantt view is currently entirely mouse-driven. Screen readers see it as a flat list of divs. Adding grid ARIA roles and keyboard navigation makes it usable for all users and aligns with HA's accessibility guidelines.

**Success Criterion:** Screen reader announces "Task: Buy groceries, March 20 to March 22, 45% complete" when navigating. Arrow keys move between cells.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 3 | 1 | **Accept** |

---

## 3. HA Integration Specialist

**Recommendation:** Ensure all three parent pages work behind HA ingress by using hash-based routing (not path-based sub-routes) and relying on the `Layout.astro` fetch monkey-patch for API calls. Add test coverage for ingress navigation to `/tasks#calendar`, `/progress#goals`, `/planning#eisenhower`.

**Rationale:** HA ingress rewrites are the #1 source of 301 redirect loops in Meitheal. Hash-based routing is ingress-safe. All parent pages must be verified in Tier 2 devcontainer before shipping.

**Success Criterion:** All parent page hash routes work correctly in HA ingress (Tier 2 devcontainer). No 301 redirects when navigating sub-tabs.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 2 | 2 | **Accept** |

---

## 4. AI/MCP Integration Specialist

**Recommendation:** Expose parent page navigation and sub-menu structure through the MCP WebMCP manifest (`public/.well-known/mcp.json`) so AI agents can navigate to specific views via tool calls (e.g., "show me the Gantt view" → navigate to `/tasks#gantt`).

**Rationale:** Meitheal's MCP integration reports available pages and actions. With three parent pages replacing 11 routes, the MCP manifest needs updating. AI agents should be able to open specific sub-views, not just parent pages.

**Success Criterion:** MCP manifest includes entries for all sub-views. AI agent can issue `navigate({ page: "tasks", section: "gantt" })` successfully.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 1 | **Accept** |

---

## 5. Astro Native Specialist

**Recommendation:** Use Astro's server-side rendering for all parent page sections (render all tabs' HTML server-side) with CSS `display:none` for inactive tabs, rather than client-side dynamic imports or lazy loading. This preserves Astro's zero-JS-by-default philosophy while keeping all content SEO-indexable and immediately available on tab switch.

**Rationale:** Settings already proves this pattern works: all sections render server-side, CSS toggles visibility, controller manages tab state. This is the Astro-native approach — minimal client JS, full SSR content. It also ensures the pages work in PWA offline mode since all content is in the initial HTML.

**Success Criterion:** Page source shows all section HTML (Kanban, Calendar, Table, Gantt) in the DOM. Tab switching is instant (no network requests). Works offline in PWA.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 1 | **Accept** |

---

**Panel Summary:** 5 Accepted, 0 Deferred, 0 Rejected

**Cross-panel synthesis:**
- All panels agree on the UnifiedBar + hash-routing pattern
- Gantt should be evolved (custom, modular) not replaced (Frontier + Optimization)
- ADHD panel's "6-item sidebar" aligns with the consolidation goal
- HA ingress testing is P0 (Optimization) — no consolidation ships without Tier 2 verification
- MCP manifest updates required for AI-native (Optimization)
