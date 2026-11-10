---
type: "Reference"
title: "Task Lifecycle Glossary"
description: "Find task status definitions and transition rules."
---

# Task Lifecycle Glossary

> **Domain:** Task Management
> **Bounded Context:** tasks
> **Last updated:** 2026-03-18

KCS article defining Meitheal's ubiquitous language for task lifecycle operations.

## Task Statuses

| Status | Canonical? | Meaning | Visible by default? |
|--------|-----------|---------|-------------------|
| `backlog` | ✅ Yes | Captured but not yet prioritized for work | Yes |
| `pending` | ✅ Yes | Ready to be worked on (aliased as `todo`) | Yes |
| `active` | ✅ Yes | Currently being worked on (aliased as `in_progress`) | Yes |
| `complete` | ✅ Yes | Work is done — definition of done met | Yes |
| `archived` | ❌ No | Complete task hidden from default views | No (opt-in via search) |

> [!IMPORTANT]
> `archived` is **not** a distinct lifecycle state. It is a visibility flag applied to `complete` tasks. A task marked `archived` has already met its definition of done — archiving simply removes it from everyday views to reduce clutter.

## Operations

### Edit a Checklist in Two Sessions

Task detail saves checklist changes against the version it loaded. Independent changes to different identified steps and new steps can be combined automatically. If a newer save changes the same step differently or the editor cannot identify the changed steps safely, it keeps your draft visible. Choose **Load latest checklist** to review the saved version alongside your draft, then make any remaining edits.

A task API client can use the same protection by sending `expected_checklists` with `checklists` in `PUT /api/tasks/{id}`. Pass the exact previous checklist value from the GET response. Use JSON `null` if the task has a historical null checklist. A stale comparison returns `409` with `code: "checklist_conflict"` and the current checklist value. The rejected update leaves all task fields untouched. Existing API callers can keep using the checklist string without a comparison.

### Activate a Task with Dependencies

If a task has a **Blocked by** link to a prerequisite, it can move to `active` after that prerequisite is `complete` or `archived`. A **Blocks** link created from the prerequisite has the same effect. Reciprocal links count as one prerequisite. The older free-text `blocked_by` field is a note and does not enforce a dependency.

If native task `PUT` or `PATCH` returns `409`, use the tasks listed in `blocked_by` to identify the open work. Complete the prerequisite or remove the dependency if it no longer applies, then retry. The rejected request does not save other edits. See the [operations runbook](operations-runbook.md#task-activation-conflicts).

### Complete (Definition of Done)
- **What it means:** The task's work is finished. All acceptance criteria are met.
- **What changes:** `status` → `complete`, `updated_at` → now
- **Reversible?** Yes — status can be changed back to any active state
- **Data impact:** None — task and all related data preserved

Completing a recurring task creates the next pending occurrence on its existing schedule. The new task keeps its area, assignee and project, and starts with an unchecked checklist. If the task has no project or its project was removed, the next occurrence has no project.

### Archive (Hide from View)
- **What it means:** A completed task is moved out of active views. This is a **convenience action**, not a lifecycle transition.
- **What changes:** `status` → `archived`, `updated_at` → now
- **Reversible?** Yes — status can be changed back (though no UI for this currently)
- **Data impact:** None — task and all related data preserved
- **Triggered by:** "Clear Done" on Today page, kanban context menu "Archive"

### Delete (Permanent Removal)
- **What it means:** The task and all its related data are **permanently and irreversibly removed** from the database.
- **What changes:** Task row deleted. Cascades to: comments, activity log, task links.
- **Reversible?** ❌ **No.** This cannot be undone. Export your data first.
- **Data impact:** Total — task and all audit trail entries are gone
- **Triggered by:**
  - **Single task:** Task detail delete button
  - **All tasks:** "Purge All Tasks" in Danger Zone (requires typing YES)
  - **Old completed tasks:** "Data Retention" in Danger Zone (requires preview + confirm)

### Purge (Nuclear Option)
- **What it means:** Every task in the system is permanently deleted, regardless of status or age.
- **Reversible?** ❌ **No.**
- **Safeguards:** Confirmation dialog → type "YES" → execute

## Severity Ladder

```
Complete → Archive → Delete (selective) → Purge (everything)
  safe       safe      DESTRUCTIVE          DESTRUCTIVE
```

## Key Distinction

| | Complete | Archive | Delete |
|---|---------|---------|--------|
| Task visible? | Yes (done lane) | No (hidden) | Gone |
| Data preserved? | ✅ | ✅ | ❌ |
| Can undo? | ✅ | ✅ | ❌ |
| Counts in stats? | Yes | No | No |
| Searchable? | Yes | Opt-in | No |
