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

### Link to another task

In Details, type `#` in the description, a new comment, or a comment you can edit. Choose a recent task, or type a ticket number or a word from its title immediately after `#` to narrow the list. Tap a result or use the arrow keys and Enter. Escape closes the list and keeps your text. A space after `#` lets you continue typing a Markdown heading in a description.

The saved link follows the task’s ID when the title changes. It opens in the current Meitheal installation and requires the reader’s normal task access.

### Pin a task

A personal pin is a relationship between one household user and one task. It survives changes to the task's workflow, including deferral and completion, and disappears when the task is permanently deleted. Shared favorites continue to drive the existing household views.

Open a task’s Details and choose **Pin task**. Open **Pinned tasks** from the sidebar or mobile menu to find it again. Choose **Unpin** in the list or toggle the Details control again. Use the Home Assistant app panel over HTTPS.

### Choose a Status or Goal When Creating a Task

Open **New Task** to load the available lanes and goals. **To Do** and **No goal** are ready immediately. If the other options fail to load, you can still create a task with the defaults. To retry the options, close and reopen the form.

On an active Home Assistant account, open **Draft** in **New Task** to save or resume one private capture. Save keeps the form open. Closing preserves the last saved revision. An unrelated New Task can still be created while a saved draft exists. Once you save or resume the current form, use **Publish draft** or Ctrl/Cmd+Enter to create the shared task. Add files from task details after publication.

If another tab edits the same draft, check for the current revision before replacing your form. If a publication is interrupted, **Check draft status** can recover the receipt. When the attempt remains unresolved, retry it with the original values or choose **Keep saved draft** to close the attempt and continue editing. **Open task** follows the original task’s identity. A receipt remains available after the task is removed.

Private drafts need an online verified Home Assistant session. Changing accounts or hiding the page withdraws the draft until the account is verified again. When prompted to update the installed web app, activate the update before checking for drafts. Text, date selections, shopping items, checklist items and custom fields are saved. Attachments are handled in task details. Event location and the all-day and routine controls round-trip in the draft and use the existing task creation rules at publication.

Publication commits one task, activity entry and event with the saved revision. A process interruption after that commit can delay or prevent an external webhook under the existing delivery behavior. Use the publication receipt to recover the task.


### Create a Checklist

Choose **Checklist** in the task form and enter one item per line. Use **Add Item** or Enter to stage the lines. Shift+Enter starts a new line. Creating the task includes any text still in the item field. If saving fails, the form keeps the staged items and draft for retry.

### Edit a Checklist in Two Sessions

In Details, select a checklist item's checkbox to mark it done. Long items wrap to fit the editor. Press Enter or leave the field to save an edit. If you reopen the same task while a save is in progress, Details waits for that save before reading the checklist.

Task detail saves checklist changes against the version it loaded. Independent changes to different identified steps and new steps can be combined automatically. If a newer save changes the same step differently or the editor cannot identify the changed steps safely, it keeps your draft visible. Choose **Load latest checklist** to review the saved version alongside your draft, then make any remaining edits.

Older text-only items open unchecked. If a concurrent edit conflicts on a step without an ID, Meitheal keeps your draft for review.

A task API client can use the same protection by sending `expected_checklists` with `checklists` in `PUT /api/tasks/{id}`. Pass the exact previous checklist value from the GET response. Use JSON `null` if the task has a historical null checklist. A stale comparison returns `409` with `code: "checklist_conflict"` and the current checklist value. The rejected update leaves all task fields untouched. Existing API callers can keep using the checklist string without a comparison.

### Defer and Resume Open Work

Choose **Defer** in a Kanban card menu or in Details to set open work aside. Open **Tasks → Deferred** to see the queue and choose **Resume**. Deferral preserves the task's status, position, dates, relationships, and history. The task leaves active work and stays available through search, Table, and scheduled or historical views.

Resuming returns the task to its existing workflow. An Active task with an open prerequisite stays deferred until the dependency is resolved. Completion clears deferral. Reopening a completed task makes it eligible for active views again.

Eisenhower's **Move to Backlog** changes the workflow status to Backlog. Use **Defer** when you want to set a task aside and return it to its current workflow later.

### Activate a Task with Dependencies

If a task has a **Blocked by** link to a prerequisite, it can move to `active` after that prerequisite is `complete` or `archived`. A **Blocks** link created from the prerequisite has the same effect. Reciprocal links count as one prerequisite. The older free-text `blocked_by` field is a note and does not enforce a dependency.

If native task `PUT` or `PATCH` returns `409`, use the tasks listed in `blocked_by` to identify the open work. Complete the prerequisite or remove the dependency if it no longer applies, then retry. The rejected request does not save other edits. See the [operations runbook](operations-runbook.md#task-activation-conflicts).

### Complete (Definition of Done)
- **What it means:** The task's work is finished. All acceptance criteria are met.
- **What changes:** `status` → `complete`, `updated_at` → now
- **Reversible?** Yes — status can be changed back to any active state
- **Data impact:** None — task and all related data preserved

Completing a recurring task creates the next pending occurrence on its existing schedule. The new task keeps its area, assignee and project, and starts with an unchecked checklist. It preserves identified steps and gives older steps without IDs an identity so separate edits can still merge on the new occurrence. The completed task keeps its original checklist. If the task has no project or its project was removed, the next occurrence has no project.

### Archive (Hide from View)
- **What it means:** A completed task is moved out of active views. This is a **convenience action**, not a lifecycle transition.
- **What changes:** `status` → `archived`, `updated_at` → now
- **Reversible?** Yes — status can be changed back (though no UI for this currently)
- **Data impact:** None — task and all related data preserved
- **Triggered by:** "Clear Done" on Today page, kanban context menu "Archive"

### Delete (Permanent Removal)
- **What it means:** The task and all its related data are **permanently and irreversibly removed** from the database.
- **What changes:** The task row is deleted, along with its comments, reactions, activity log, and task links.
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

### Inactivity

Open **Tasks → Inactivity** to see open work that is ready to move to Deferred or within seven elapsed days of its cutoff. The rule starts Off. An administrator can set a shared interval and give an Area its own interval, turn the Area Off, or let it inherit. Preview the proposed policy before saving. If an Area or rule changes while you review, preview again before saving. Existing work that is already past the new cutoff can move at the next sweep.

The cutoff uses the most recent task activity, including comments and a real Resume. Scheduled work, reminders, recurring work, and confirmed calendar links, and active work with open prerequisites are protected. Automatic moves keep the task's workflow status. The Deferred queue identifies automatic moves and offers **Resume**, which starts a fresh inactivity window.

## Task participation

Comments record shared task context. Reactions add a short acknowledgment to a task or comment. Home Assistant ingress checks current membership for writes and keyed comment retries. Existing comments remain visible to callers with task access. Edit and delete still belong to the original author. For account recovery and API behavior, see the [operations runbook](operations-runbook.md).
