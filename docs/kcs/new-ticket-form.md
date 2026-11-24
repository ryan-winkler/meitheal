---
type: Guide
title: "Create a ticket"
description: "Use the grouped ticket form, checklist capture and private drafts."
---

# Create a ticket

Choose **New Task**, then select **Task**, **Shopping**, **Checklist** or **Event**. Enter a title of up to 500 characters and an optional description of up to 10,000 characters. The form scrolls independently, keeping its heading and create action available on narrow screens.

**Ticket details** contains status, priority, due date and assignee. Assignee is hidden when nobody is available. **More options** contains Goal, Repeat, Tags and custom fields. Goals remain available even when there are no assignees. Tags, their suggestions and the empty state use the current app surface and readable text in Light, Dark and Auto. Choose the selectors with the keyboard or touch controls. Due dates use the shared calendar picker; opening or dismissing it keeps the saved date and time unchanged. Calendar day capture preselects its date for the next new ticket.

For a checklist, paste one item per line into **New items**. **Add Item** or Enter adds the items to the list; Shift+Enter inserts another line. Each row has its own remove button. Shopping uses a quantity, category and item name. For an event, choose **Starts** and **Ends**; an end at or before the start keeps the form open with an explanation.

The creation form does not offer routine, agent, attachment, all-day, location or calendar-selection actions that the ticket creation service cannot save. Use **Habits** for routine templates. Add images from ticket details after creation.

Where private drafts are available through Home Assistant, the **Draft** actions save and resume the capture separately from publication. Resuming a draft opens More options when it has saved goals, repeat settings, tags or custom fields. Checklist identities, pending writes and the existing one-time publication flow are preserved. Older private draft metadata remains in its snapshot without exposing unsupported creation controls. Resuming and saving keeps multiline titles, all supported priorities (1–5), saved custom recurrence rules, timed or date-only due values, and event seconds and milliseconds. Existing ISO offsets remain unchanged until you edit their date control.

If creation fails, the form keeps its entries and reports the failure. Review the message before retrying. After an interrupted request, check whether the ticket exists before creating another copy. Successful creation opens the canonical ticket URL.

## Form checks

Run the focused `new-task-modal.spec.ts` and `new-task-capture-options.spec.ts` browser checks against a disposable local Astro dev server. They cover keyboard focus, grouped controls, 320-pixel layout, goals without assignees, delayed option reads, failed-create retry and stable multiline checklist IDs. Draft publication and ingress checks use `task-draft-browser.spec.ts` with the built App and its isolated HTTPS fixture. The legacy-draft cases seed valid prior snapshots through the guarded API and verify that unrelated edits, saving, reloading and publication preserve their values across browser timezones.

A viewport resize can produce the browser's benign ResizeObserver delivery diagnostic. It does not trigger a global failure toast; actual uncaught application failures still do. The regression check covers both outcomes.


## Shared Ticket Properties, Field Layout & Description Editor

- **Prefill Deep Links (`?create=1`)**: Open the New Task editor pre-populated with URL query parameters (`title`, `description`, `priority`, `status`, `due_date`, `area_id`, `project_id`, `parent_id`, `task_type`, and custom fields via `apps/web/src/lib/task-url-prefill.ts`). Meitheal opens an editable draft without auto-submitting, and strips the query parameters with `history.replaceState` after hydrating so reloads do not recreate duplicate drafts. Use **Copy prefill link** inside `NewTaskModal.astro` to share or bookmark a prefilled template.
- **Shared Properties & Customizable Field Layout**: `NewTaskModal.astro` shares the full property model with `TaskDetailModal.astro`: **Properties** (`Status`, `Work type`, `Priority` with contained priority icon badge, `Urgency`, `Importance`, `Assignee`, `Area`/Group, `Home Assistant Area`, `Project`, `Pillar`, and dynamically filtered `Principle`), **Scheduling** (`Due Date`, `Goal`, `Repeat`, `Progress`), and **Metadata** (`Tags`/Labels, optional `Task Color`, board-defined custom fields from `/api/custom-fields`, and ad-hoc custom fields). Use **Task detail layout** (`#nt-toggle-layout` / `<TaskDetailLayoutEditor>`) to show, hide, reorder, or rename fields consistently across both modals.
- **Tabler WYSIWYG / Markdown / Preview Editor**: Both `NewTaskModal.astro` and `TaskDetailModal.astro` mount `enhanceDescriptionEditor` (`apps/web/src/lib/task-description-editor.ts`) inside `.md-editor-frame` with Tabler sprite toolbar actions (including working Bullet, Numbered, and Task list toggles plus `Enter`/`Tab` continuation and empty-marker exit), a right-aligned `[Visual | Markdown | Preview]` `tablist`, and self-hosted HugeRTE assets (`apps/web/scripts/generate-hugerte.mjs` staged to `apps/web/public/vendor/hugerte/`). Both modals flush Visual changes via `flushToTextarea()` before saving or submitting so direct saves from Visual mode persist reliably.
- **Board Session Conflict Recovery**: Before failing with `409` on creation, `NewTaskModal.astro` checks for stale board session metadata via `GET /api/boards/{id}?view=authority` and retries once automatically with the refreshed header token. Empty `due_date` strings are omitted from `POST /api/tasks` payloads, while `pillar_id` and `principle_id` persist across both task creation (`POST /api/tasks`), draft persistence (`PUT /api/task-drafts`), and detail updates (`GET`/`PUT /api/tasks/[id]`).
