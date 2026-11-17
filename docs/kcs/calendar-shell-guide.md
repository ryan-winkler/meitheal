---
type: "Guide"
title: "Calendar Shell Guide"
description: "Understand the calendar view and its controls."
---

# Calendar Shell Guide

## What Changed

Calendar opens within **Tasks** at `/tasks?view=calendar`. Older `/calendar` and `/tasks#calendar` bookmarks still open that view and keep their query parameters. The **Task views** navigation marks the current view and links to Kanban, Table, Calendar and Timeline. Use Tab to reach each link and Enter to open it with the current filters. The bottom navigation highlights Calendar on mobile.

## Common Jobs

### Move around the month without losing the shell context

1. Use **Previous month**, **Next month** or **Today** above the grid.
2. Filter by title, task type, status, priority, label, area, or custom rules above the month. **Overdue** shows open tasks past their due date and skips deferred work. On phones, select **Filters** to open these controls, then **Filter** to edit custom rules. **Active** shows that filters still apply when the controls are closed. **Promoted cards only** narrows the task results to work moved to the top of a Kanban lane.
3. Open any day in the displayed month to review matching due tasks and local Events that start that day. The number beside the calendar icon counts local Event starts and saved calendar occurrences for that day. The month totals each saved calendar occurrence once, even if it appears on several days. The day drawer lists saved and live events in its connected section using Meitheal’s household timezone. All-day events stay on their calendar dates. Household members can see the configured feed in Calendar. Administrators manage the sources in Settings. Tasks and local Events come from the Household Board. Open a named Board to see its tickets. Turn off **Events** in the type filters to hide local Events and connected event previews and counts.
4. The month controls keep the active filters. Use **Clear All** to start over. Its accessible name is **Clear all active filters**.

### Open a day drawer and create follow-up work

1. Select a day in the month grid using a pointer, Enter or Space.
2. Review **Scheduled items** and **Connected Calendar Events**. Local Event rows show their start time or **All day**. Task rows show the shared status label and icon. Connected timed events that span midnight show their original start date on days when they continue. Saved Home Assistant and CalDAV events open their linked task and remain available if the live source is unavailable. Multiple starts from a recurring event can appear on the same day. Archived tasks are hidden. Without task filters, the agenda also shows completed tasks that are absent from the month count.
3. When more than 100 tasks and local events match a day, use **Load more items** in the agenda. Changing a task’s status from Details refreshes the month counts under the current filters.
4. Use **Add Task** to open the shared form with the selected due date, or **Add Event** to start an Event on that date. A newly created Event appears on its start day even with no calendar connection.

Assistive technology announces the visible day number first, followed by the month and year and the task count when a badge is shown. The current date is identified as today. Weekend headings and the current date remain distinct in light and dark themes. On narrow touch screens, the month grid uses more of the screen width so neighboring days have separate tap targets.

### Switch to another task view without dropping filters

1. Apply the filters you want on Calendar.
2. Choose **Table** or **Kanban** from the Tasks view tabs.
3. Confirm the selected filters remain in the URL after the view changes.

## Troubleshooting

### Calendar sync reports incomplete work or stops retrying

Open **Settings → Connected Services → Calendar Sync** and check the selected entity and its last sync error. A failed event import or stale-event reconciliation keeps the entity in an error state. Manual sync returns an incomplete result (HTTP 502), including counts for imports already saved; those saved tasks remain available.

Clearing all selected Home Assistant calendars also stops the App from picking up an older saved calendar after a restart. Choose a current source to resume its sync.

Repair the reported Home Assistant or database problem, then use **Sync now** to retry. Manual sync resets that entity's failure backoff and clears its error only after a successful attempt. Background sync pauses after five consecutive failed attempts; each attempt counts once, even when several events fail. A concurrent or export-only sync is skipped rather than reported as a completed import. Disabling and re-enabling sync also starts a fresh entity session.

The same **Sync now** action includes an active CalDAV import. A failed calendar fetch, database import, credential check or discovery keeps the CalDAV error visible and returns an incomplete result. Completed imports retain their counts. Each imported task and its confirmation commit together. When a sync combines old event links into a series, it releases them only when it saves the new link. Repair the failure and run **Sync now** to retry. Background CalDAV sync pauses after five failed attempts; manual sync retries after repair. Status identifies this source as `caldav` without exposing the server URL or password.

### A calendar change does not reach Meitheal

Meitheal syncs two kinds of calendar: Home Assistant calendar entities, and CalDAV calendars (such as Nextcloud) added under **Settings → Connected Services → External Calendar (CalDAV)**. Each point applies to both unless it names one. Use **Sync now** (see [Calendar sync reports incomplete work or stops retrying](#calendar-sync-reports-incomplete-work-or-stops-retrying)) to check a change straight away.

Check these first:

- **Sync direction (Home Assistant).** A Home Assistant calendar set to **↑ Export only** never brings changes into Meitheal. Choose **↓ Import only** or **↔ Bidirectional** with the direction selector on that calendar's card under **Settings → Connected Services → Calendar Sync**. CalDAV calendars only import.
- **Background sync.** Sync runs on the **Sync Interval** shared by all calendars (every 5 minutes by default) and when Meitheal starts. Home Assistant calendars also sync about 10 seconds after the calendar's current or next event changes; edits to later events wait for the interval. With **Manual only**, the interval stops, but Home Assistant calendars still sync on those other triggers. Press **Sync now** to sync at once.
- **Events Meitheal sent.** Meitheal adds "Added from Meitheal" to the description of events it sends to a calendar, and never imports those events back from Home Assistant or CalDAV. Edit those tasks in Meitheal, not in the calendar app.
- **Shared CalDAV invitations.** Two calendars can contain the same invitation. Each has its own task. If a task from an older version was linked only by a display name used by more than one calendar, sync leaves that task alone and imports the two calendar copies separately. If an older link names exactly one calendar, sync attaches it to that calendar on the next import.
- **Sync window.** Sync reads events from 7 days ago to 30 days ahead. A CalDAV event that started earlier still counts if its end overlaps the window. That includes events whose calendar supplies a duration instead of an end time. Very long filtered repeats can exceed the scan limit. If that happens, sync reports an incomplete import and still saves the other events.

**A field was edited in Meitheal.** Sync does not overwrite a title or date that someone edited in Meitheal. On each sync, Meitheal compares the task's due date, start date and end date, and the title of an Event task, with what the calendar sent last time. If the field still holds that value, it takes the calendar's new value. If someone changed it, the Meitheal value stays and Meitheal does not show that it was edited. The due date and start date both follow the event's start. Sync creates Event tasks; you can also pick **Event** in the New task form.

To bring an edited title or all-day date back in step, make the calendar and Meitheal show the same value once, for example by changing the event in the calendar app. From the next sync after they match, the field follows the calendar again. The match must be exact, including the time and time zone, so timed dates rarely match again. For those, set the date in Meitheal to the value you want; it then stays as set. With Home Assistant, renaming an event usually replaces its task instead (see the next section), so titles follow the calendar reliably only for CalDAV.

A calendar sync that changes a task advances its edit version, even if someone saved another field after the sync started. If a Home Assistant edit reports a version conflict, refresh the task and retry. A sync that leaves the task unchanged keeps its version.

**Fields that always follow the calendar.** With Home Assistant sync, if the event has a location or a description, it replaces the description of the task linked to it, including a task you made yourself. Keep notes in a comment or checklist instead. CalDAV sync writes the description once, when it imports the event, and keeps notes you add in Meitheal after that. Home Assistant sync also adds the `calendar-sync` label to linked tasks and puts it back if it is removed. Leave that label in place.

### A synced task completed itself, or a second task appeared

**Home Assistant: the event left the window or was deleted.** A task that sync created is marked complete when its event left the sync window or was deleted. This happens only when the calendar still returns at least one event and the sync had no errors. If the event comes back into the window, the task stays complete unless Meitheal treats the event as repeating (see the next section). Reopen it by hand if you need it. CalDAV never completes tasks this way; complete or delete them yourself.

**Home Assistant: events without an ID.** Home Assistant sends events without a unique ID, so Meitheal recognises an event by its exact title and its time of day. Events with the same title (ignoring capitals) at the same time of day, or all-day events with the same title, become one repeating task only when at least three of them are in the sync window and their dates follow a regular pattern (daily, weekly, fortnightly, monthly). Otherwise each event gets its own task, so two separate appointments with the same title stay separate. Once a series has a task, it stays one task even when the window shows just one occurrence, or grows from one to two. Unrelated events that happen to repeat regularly with the same title and time still become one task; give them different titles. When an event moves, sync keeps the same task if the task is still open and its title still matches the event. If the event is renamed, or the task was renamed or completed in Meitheal, sync completes the old task and creates a new one.

**Home Assistant: an existing task with the same title.** When an event is new to Meitheal, sync links it to one open task with exactly the same title only if sync created that task, or Meitheal sent it to a calendar. A task you created in Meitheal is never linked, even if it is an Event task with the same title: the event gets a task of its own, and your task keeps its own repeats. A task that an earlier version linked this way is let go on the first sync. Tasks from another Home Assistant calendar or from CalDAV are never linked. A linked task keeps its own title and dates until they match the calendar once, as described above. A task already linked to another event in the same calendar is not reused, so a second event with the same title gets its own task. CalDAV never links an event to an existing task by title.

**Deleting a synced task.** Sync does not restore a deleted standalone task when its calendar event is rescheduled and retains the same ID. For a repeating series, the next occurrence after the deleted one gets a new task when it comes up.

**Tasks sent to the calendar.** Meitheal sends tasks with a due date to the first Home Assistant calendar set to **↑ Export only** or **↔ Bidirectional**, and only when **Write back** is on under **Calendar Sync**. Tasks imported from a calendar are never sent back, so they do not appear twice in the calendar app. CalDAV calendars are never written to. Add the `no-sync` label to any task that should never be sent.

### A repeating calendar event shows no repeat rule, or reopens after completion

The calendar controls when a synced event repeats. A task shows a repeat rule only when the calendar sends one. CalDAV calendars send rules. Home Assistant usually sends only the date of each occurrence, so a Home Assistant Event task normally shows no repeat rule; that is expected. If the calendar drops its rule, Meitheal clears the task's rule too, unless someone changed the rule in Meitheal. A known series keeps its identity when only one occurrence is in the window. Do not add a rule to an Event task in Meitheal; set the repeat in the calendar app instead.

Meitheal treats an Event task as repeating when the calendar sends a rule, or when it sees at least three occurrences on different days that follow a regular pattern within the sync window. A daily or weekly series qualifies, and a fortnightly one once three dates are in view (the window covers 37 days). For a series with longer gaps, such as monthly, every six weeks, quarterly or yearly:

- **CalDAV, or any event that sends a rule:** the task reopens by itself when the next occurrence comes within 30 days.
- **Home Assistant without a rule or known series identity:** the completed task stays complete, and sync creates a new Event task when the next occurrence comes within 30 days. Do not create one yourself, or you will have two.

Completing an ordinary repeating task, or an Event task you created in Meitheal, creates the next task in the series. Completing a synced Event task does not. Instead, on the day after the completed occurrence ends, the next sync reopens the same task as pending and moves it to the next occurrence, as long as that occurrence is within 30 days. Dates someone edited in Meitheal do not move. Reopening is expected. To stop it, end or delete the series in the calendar app; for CalDAV, then also complete or delete the task.

### Repeat dates in Meitheal differ from the calendar app

Home Assistant sends the date of each occurrence, so a difference there usually means the dates were edited in Meitheal (see [A calendar change does not reach Meitheal](#a-calendar-change-does-not-reach-meitheal)). For CalDAV calendars, Meitheal works out each occurrence from the event's repeat rule. It supports daily, weekly, monthly and yearly repeats with a set interval, plus:

- chosen days of the week, such as every weekday;
- a numbered weekday in each month, such as the second Tuesday or the last Friday;
- a day of the month, including the last day;
- the last working day (Monday to Friday) of each month;
- a weekday in a given month each year, such as the last Sunday in March;
- an end date or a set number of repeats.

Known differences:

- A monthly series on the 29th, 30th or 31st skips months that do not have that day, and a yearly series on 29 February skips common years. This matches CalDAV servers and most calendar apps. To land on the last day of every month, choose "last day of the month" in the calendar app.
- Repeats more often than daily are not supported: Meitheal imports only the first occurrence, and only when it falls inside the sync window.
- A repeat rule that uses an option Meitheal does not support, such as specific hours of the day (`BYHOUR`), is not expanded at all: Meitheal imports only the first occurrence, and only when it falls inside the sync window. If later occurrences are missing, check the rule in the calendar app for options like these.
- Combined rules such as "Friday the 13th" repeat only when both the weekday and the date match.

### The drawer opens but tasks or events stay empty

1. Confirm the day drawer title updates to the selected date.
2. If the drawer can’t load the first or next agenda page, select **Retry agenda**. If **Saved calendar links couldn’t load**, reopen the day. The first page reports independently whether scheduled work and saved links loaded. Successful results stay visible if the other read fails. If the retry fails, inspect the read-only `POST /api/calendar/agenda` request in the Network panel. The response applies filters before pagination and returns a matching `total` when scheduled work loads. Date-only values match directly. A timestamp with a time and offset matches the resulting day in the household time zone.
3. The default month badge excludes Complete and Archived work. By default the drawer includes completed work, including when an old link lists every task type. Ordinary task filters exclude Complete and Archived in both places. Choose **Complete** or apply custom rules to include matching completed work in both places. When a task status looks wrong, compare the list result with the status sent on creation. Known aliases such as `done` become the built-in status `complete`. Custom statuses keep their names.
4. **Live Home Assistant calendars couldn’t refresh** means the app could not load the configured source list or every requested live feed failed. **Some live Home Assistant calendars couldn’t refresh** means some feeds failed and the remaining feeds responded, even if they had no events. Reopen the day to retry live feeds. Month previews read the first three configured sources and show up to two live events per day before the overflow count. The day drawer reads the first five sources. The month totals each saved occurrence once. Day badges count the saved occurrences covering that day. Check the configured entities and use the Network panel to identify a failed request.

### Calendar changes could not be applied

If Calendar had already loaded, it keeps the last successful results. Select **Retry calendar** to repeat the failed request. Month navigation after a failure keeps the last applied filters. If the rule editor asks you to shorten a rule, edit the draft and select **Apply Rules**, or select **Clear Rules** to remove the draft and any applied rules. Whenever **Retry calendar** appears, it repeats the earlier failed request. Correct the draft and apply it separately. To reset all applied filters, use **Clear All**.

### View switching loses the current filters

1. Confirm the target view-pill link contains the expected query string before clicking it.
2. If the query string disappears after navigation, record the source route, target route, and active filters.

## Virtualized Timeline View (`/tasks?view=timeline`)

The sibling Timeline view (`/tasks?view=timeline`) renders scheduled bars, milestones, and unscheduled rows through synchronized `requestAnimationFrame` vertical row windowing across `.gantt-sidebar-track` and `svg.gantt-native` (`<= 60` mounted bar groups and `<= 450` timeline DOM nodes on 500-task schedules). A milestone keeps its chosen task color. An overdue milestone adds a danger outline and an overdue label for assistive technology. `Day` and `Week` zoom modes use a repeating SVG `<pattern>` background grid, while `Month` zoom renders exact 1st-of-month `<line>` dividers. Active pointer drags and focused rows remain mounted when scrolled outside the viewport window, `ArrowDown`/`ArrowUp` and `j`/`k` navigate across `displayRows` by row index (`role="grid"`, `aria-rowcount`, `aria-rowindex`), narrow bars (`< 96px`) render external right-hand labels, and PNG schedule exports compute sidebar row offsets from `data-row-index` at any scroll position.
