# Panel 2: ADHD/Productivity — Sidebar Hierarchy Tree

**Objective**: Reduce cognitive load and improve execution velocity  
**Phase**: Sidebar Visual Polish  
**Iteration**: 01  

---

## 1. Workflow Coach — Reduce Prompt Friction

**Recommendation**: Add a quick-capture shortcut — pressing `N` (or a keyboard shortcut) when focus is inside the sidebar opens an inline task input for the currently active project, without needing to click + → pick kind → prompt.

**Success Criterion**: Pressing a shortcut key opens inline input on the active project row. Task is created on Enter without any popup.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 4 | 2 | **Defer** — High impact but requires inline input infrastructure first. Depends on accepting Frontier #2 (remove prompt). |

---

## 2. Execution Coach — Inline Rename Instead of Prompt

**Recommendation**: Replace `prompt("New area name:")` with an inline contenteditable span that activates on the area/project name. User types directly, presses Enter to save, Escape to cancel.

This directly reinforces Frontier Panel #2 and is the correct UX pattern. `prompt()` breaks execution flow, requires context switching, and is blocked in HA.

**Success Criterion**: Double-click or Rename action converts name to editable field. Enter saves, Escape cancels.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 3 | 2 | **Accept** — Directly unblocks HA ingress usage. Combine with Frontier #2. |

---

## 3. Knowledge Coach — Tooltip for Pinned Section

**Recommendation**: Add a small help tooltip or `title` attribute explaining how to pin/unpin projects (right-click). This is a hidden feature with no discoverability.

**Success Criterion**: Pinned section header includes a small "?" icon with tooltip explaining right-click to pin/unpin.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 1 | 1 | **Accept** — Trivial to add, significant UX discovery improvement. |

---

## 4. Focus Optimizer — Audit Prompt Strings for i18n

**Recommendation**: The JS section still has 4 hardcoded prompt strings (`"New project title:"`, `"New area name:"`, `"Task title:"`, `"New area name:"`) and 1 confirm string that bypass the i18n system. When inline inputs replace prompts, these strings must route through the translation system.

**Success Criterion**: Zero hardcoded English strings in JS. All user-facing text uses i18n keys.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 1 | **Accept** — Bundle with inline-input work. Required for Irish locale. |

---

## 5. Automation Coach — Auto-update Sidebar After Mutation

**Recommendation**: After creating/renaming an area or project, update the DOM inline instead of `window.location.reload()`. This eliminates the full-page reload which is the single biggest latency cost in the sidebar workflow. At minimum, update the area/project name text node after rename.

**Success Criterion**: Rename changes the visible text in the sidebar without page flash. Create adds a new DOM node in the correct position.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 4 | 3 | **Defer** — High value but requires building a sidebar DOM update engine. Defer until inline inputs are in place. |
