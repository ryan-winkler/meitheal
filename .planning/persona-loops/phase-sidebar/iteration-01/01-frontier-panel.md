# Panel 1: Frontier Experts — Sidebar Hierarchy Tree

**Objective**: Identify remaining high-impact architectural, integration, and UX improvements  
**Phase**: Sidebar Visual Polish  
**Iteration**: 01  

---

## 1. Platform Architect — Runtime Path Hardening

**Recommendation**: Replace `window.location.reload()` after every mutation (rename, delete, color/icon save, new project, new area, new task) with targeted DOM updates.

The sidebar currently calls `window.location.reload()` 6 times after successful API calls. Each reload re-fetches the entire page, re-initializes all JS, and causes a full-screen flash. This is especially jarring inside HA ingress where reload latency is higher.

**Success Criterion**: After rename/color-change/add-project, only the affected DOM node updates — no page reload flash.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 4 | 3 | **Defer** — High impact but cross-cutting (6 mutation handlers + DOM update logic). Add to backlog. |

---

## 2. OSS Integrations Specialist — Remove Prompt() Dialogs

**Recommendation**: Replace all 4 `prompt()` calls (new project, rename area, rename project, new task) with inline editable inputs that appear in-place.

Native `prompt()` is blocked entirely in HA ingress iframe context, Android WebView, and many PWA environments. This means the rename and create features silently fail for a meaningful percentage of users.

**Success Criterion**: All inline inputs work inside HA ingress webview. No native `prompt()` or `confirm()` calls remain.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 3 | 2 | **Accept** — Critical for HA add-on context. `prompt()` is fundamentally broken behind iframe sandboxes. |

---

## 3. Reliability Engineer — Silent Error Swallowing

**Recommendation**: Add user-visible toast/snackbar feedback when API calls fail. Currently all 6 `catch {}` blocks silently swallow errors — the user has no idea if rename, delete, or create failed.

**Success Criterion**: Every failed API mutation shows a non-blocking toast with the error message.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 1 | **Accept** — Silent failures erode trust. Toast system likely exists or is trivial to add. |

---

## 4. Security Engineer — Confirm Dialog for Destructive Actions

**Recommendation**: Replace `confirm()` for area deletion with an inline confirmation step (a brief "Are you sure?" button swap), since `confirm()` is also blocked in many webview/iframe contexts.

**Success Criterion**: Delete area shows inline confirmation that works behind HA ingress. No native `confirm()` calls.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 1 | **Accept** — Same iframe issue as `prompt()`. Bundle with the inline-input work. |

---

## 5. Product Architect — Project Delete From Sidebar

**Recommendation**: Add a "Delete Project" action to the project ⋯ menu dropdown. Currently projects can only be deleted from the project detail page. The area menu has Delete but the project menu does not, which is an inconsistent feature surface.

**Success Criterion**: Project dropdown has Delete with inline confirmation. Project is removed from sidebar without page reload.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 2 | **Accept** — Simple consistency fix: add one more dropdown item + confirm step. |
