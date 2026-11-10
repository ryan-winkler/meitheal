---
type: Guide
title: "Create a ticket"
description: "Use the grouped ticket form, checklist capture and private drafts."
---

# Create a ticket

Choose **New Task**, then select **Task**, **Shopping**, **Checklist** or **Event**. Enter a title of up to 500 characters and an optional description of up to 10,000 characters. The form scrolls independently, keeping its heading and create action available on narrow screens.

**Ticket details** contains status, priority, due date and assignee. Assignee is hidden when nobody is available. **More options** contains Goal, Repeat, Tags and custom fields. Goals remain available even when there are no assignees. Choose the native selectors with the keyboard or touch controls.

For a checklist, paste one item per line into **New items**. **Add Item** or Enter adds the items to the list; Shift+Enter inserts another line. Each row has its own remove button. Shopping uses a quantity, category and item name. For an event, choose **Starts** and **Ends**; an end before the start keeps the form open with an explanation.

The creation form does not offer routine, agent, attachment, all-day, location or calendar-selection actions that the ticket creation service cannot save. Use **Habits** for routine templates. Add images from ticket details after creation.

Where private drafts are available through Home Assistant, the **Draft** actions save and resume the capture separately from publication. Resuming a draft opens More options when it has saved goals, repeat settings, tags or custom fields. Checklist identities, pending writes and the existing one-time publication flow are preserved. Older private draft metadata remains in its snapshot without exposing unsupported creation controls.

If creation fails, the form keeps its entries and reports the failure. Review the message before retrying. After an interrupted request, check whether the ticket exists before creating another copy. Successful creation opens the canonical ticket URL.

## Form checks

Run the focused `new-task-modal.spec.ts` and `new-task-capture-options.spec.ts` browser checks against a disposable local Astro dev server. They cover keyboard focus, grouped controls, 320-pixel layout, goals without assignees, delayed option reads, failed-create retry and stable multiline checklist IDs. Draft publication and ingress checks use `task-draft-browser.spec.ts` with the built App and its isolated HTTPS fixture.

A viewport resize can produce the browser's benign ResizeObserver delivery diagnostic. It does not trigger a global failure toast; actual uncaught application failures still do. The regression check covers both outcomes.
