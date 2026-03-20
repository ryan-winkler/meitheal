# Panel 1: Frontier Experts

**Objective:** Hierarchy Architecture Overhaul — three parent pages, pinnable sub-menus, routine templates, Gantt
**Phase:** 15 · **Iteration:** 01

---

## 1. Platform Architect

**Recommendation:** Create a shared `ParentPageShell` Astro component that encapsulates the UnifiedBar + hash-section + controller lifecycle pattern, rather than duplicating the boilerplate across three new parent pages.

**Rationale:** Settings.astro is 578 lines. Copying that pattern for `/tasks`, `/progress`, and `/planning` creates 1,734 lines of near-identical shell code. A shared component with a `sections` prop eliminates duplication and makes future parent pages trivial.

**Success Criterion:** All three parent pages render correctly using `<ParentPageShell sections={...} />` with zero duplicated shell/tab logic.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 3 | 2 | **Accept** |

---

## 2. OSS Integrations Specialist

**Recommendation:** Pin Frappe Gantt to a specific major version in `package.json` (e.g., `"frappe-gantt": "^1.0.0"`) and vendor the CSS file locally instead of importing from `dist/`, since Gantt SVG themes must match Meitheal's design tokens.

**Rationale:** Gantt CSS ships with hardcoded colors. Meitheal uses CSS custom properties. Vendoring the CSS lets us replace hardcoded values with `var(--*)` tokens. Pinning prevents breaking changes from upstream.

**Success Criterion:** Frappe Gantt renders with Meitheal's theme (dark mode, accent colors) without a separate color override stylesheet.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 1 | **Accept** |

---

## 3. Reliability Engineer

**Recommendation:** Add a `last_spawned_at DATETIME` column to `routine_templates` and implement idempotent spawn logic that checks for existing instances before creating, using a unique constraint on `(routine_template_id, spawned_for_date)`.

**Rationale:** Without idempotency, server restarts, timezone changes, or concurrent requests can double-spawn routine instances. This is the #1 reliability bug in habit trackers.

**Success Criterion:** Running `spawnDueInstances()` twice in succession creates exactly one instance per template, verified with a unit test.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 2 | 2 | **Accept** |

---

## 4. Security Engineer

**Recommendation:** Add server-side validation that the `is_default` flag on the "Every Day" project cannot be set via API — only through `ensureDefaultProject()`. Prevent any API route from deleting a project where `is_default = true`.

**Rationale:** Without this guard, a malicious or buggy client could delete the default project or create additional default projects, breaking the "always has a capture target" invariant.

**Success Criterion:** `DELETE /api/projects/:id` returns 403 for the default project. `PUT /api/projects/:id` ignores `is_default` in the request body.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 1 | 1 | **Accept** |

---

## 5. Product Architect

**Recommendation:** Implement the sidebar order redirect mapping as a `PARENT_PAGE_ROUTES` constant that the sidebar, redirect routes, and search hub all consume from a single source of truth.

**Rationale:** With 7 old routes redirecting to 3 parent pages, maintaining the mapping in multiple places (sidebar config, redirect pages, search results) will drift. A canonical mapping prevents broken links.

**Success Criterion:** Adding a new sub-view to a parent page requires editing exactly one file (the registry) plus creating the component.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 1 | **Accept** |

---

**Panel Summary:** 5 Accepted, 0 Deferred, 0 Rejected
