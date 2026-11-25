---
type: "Guide"
title: "Kanban Shell Guide"
description: "Understand the board layout and task controls."
---

# Kanban Shell Guide

Open **Tasks** and select **Kanban** to see the board. The area picker, task filters, SearchHub, Assist, lane management, and new-task controls sit above it.

**By RICE Score** groups the loaded cards in each lane into High, Medium, Low and Needs a score, using the same thresholds as Table. To change a card's RICE group, edit its score. Dragging between workflow lanes preserves the card's current score.

The Tasks view uses the Household board. A bookmark for an unavailable Board shows a 404 and keeps Household task data out of the response. If a task automation receives that response, check its Board selector and use an Area or Project filter when the intended scope is within Household. The legacy bulk purge returns 400 for an explicit Board selector.

## Common Jobs

### Work in an area

Use **All Areas** above the board to select a specific area. The card and lane counts follow that selection and the task filters. **Add Task** at the bottom of a lane captures a task in the selected area and lane. Press Enter or choose **Add** to save. If the save fails, the form keeps the title available for retry. **Cancel** or Escape closes the form.

Choose **Group by → By Area** to group the current page of cards within each lane. Groups sort by the displayed Area name. Unfiled tasks and tasks that refer to a retired Area stay visible under **No area**. Open a task to move it to an available Area.

### Move or open a card

- Select the card's task key, such as **MTH-42**, to open the full task. With a task key focused, use Up and Down within a lane, Left and Right between lanes, and Enter or Space to open. Press N to open quick capture in that lane.
- Open **⋯** at the top of a card and pick a lane under **Move to**. This works with keyboard, mouse, or touch. Escape closes the actions and returns focus to the card. To reverse a move, choose the previous lane.
- You can also drag the card. On touch, swipe to scroll the board, or hold the card body until it lifts, then drag it into the destination list. The card previews its destination while Meitheal saves. A rejected move returns it to its original lane.

The task key is part of the card button’s accessible name. When one quick action replaces another, only the current dialog accepts keyboard input.

On desktop pointers, quick actions float in a frosted-glass bar at the bottom corner of the card when hovered or keyboard-focused so idle cards use their full height; on touch devices they remain directly tappable below the task details.

Tab and Shift+Tab stay inside task detail while it loads and while you edit. Press Escape to close it and return to the card. When a confirmation is open, Escape dismisses the confirmation first.

The title becomes editable when task details and edit permission are ready. Viewers can read and copy the title.

Closing Details while a task is still loading also clears its pending launch link. Your Board and Project filters remain in the address, so the next task creation or refresh does not reopen the dismissed task.

### Promote a card

Open a card’s **Task actions** and choose **Promote to top** to move it above ordinary cards in the same lane. Everyone using the board can see the **Promoted** badge. Use **Promoted cards only** to see just those cards. The count strip confirms the filter is active. Bookmark the resulting URL to reopen that filter. Work-in-progress counts still include all cards in the lane.

Choose **Remove promotion** from the same menu to return the card to its normal position. Promotion leaves the task’s priority intact. Drag to reorder within either group, or move a card to another lane to carry its promotion with it.

### React to a task or comment

Open a task and select **Task reactions**, or use **Comment reactions** beside a comment. With a verified Home Assistant identity, you can add an emoji or up to 16 characters of text and remove your own reactions. If saving fails, your draft remains available to retry. Choose **Older reactions** to see earlier entries.

A card's reaction count covers the task itself. Open the task to see who reacted or to read reactions on its comments.

The board remains usable when reaction counts are unavailable. A denied request clears the displayed count until it can be read again.

### Manage lanes without leaving the board

1. Open `Kanban`.
2. Open **Lanes**. On a phone, open **Board actions** first.
3. Keep the board visible while renaming/aliasing built-in or custom lanes, changing lane accent colors, reordering lanes, and editing WIP limits.

### Change card density without fighting the shell

1. Open **Fields**. On a phone, open **Board actions** first.
2. Use the card customizer search input there to find any built-in or board custom field without expecting field toggles in the shell.
3. Compact density hides secondary card rows such as description, metadata, labels, progress, and custom fields so dense boards stay scannable.
4. Close **Fields** to return to the board.

### Page through a large board

The destination lane displays **Moving task…** while a move is being saved. Board loading and retry use the existing status line. The drop highlight fits within the lane so it keeps the same scrollable area while you drag.

Each lane shows up to 25 cards. Its count includes every task matching the current area and filters. The range below the lane shows which cards are loaded. Use **Previous** or **Next** to page within that lane. Use **Filter by text** or the filter builder to find a task anywhere in the board, including other pages. Changing the area or filters returns the lanes to their first page.

Household Kanban reloads its results in place. The refresh requests the same scoped page with `boardRefresh` and `X-Meitheal-Task-Fragment: 1`, so the response skips the shared page shell. Ordinary navigation still includes the shell. If a refresh fails, use **Retry board** to retain your last visible results until a new response succeeds.

To move a task to another Area on its Board, open **Details** and choose the destination in **Area**. After the save succeeds, the card appears in its new group when Details closes. If the destination group is collapsed, focus returns to its heading. If the Board is filtered to the original Area, the card leaves the results and the filter stays selected. When a save is rejected, **Reload saved task** lets you recover the latest saved value. Use **Home Assistant Area** separately to edit the task's location when that control is available.

Open **Overdue** from Dashboard to filter tasks across every Kanban page. The board matches Dashboard’s due-date and completion rules.

Use a swimlane’s group heading to show or hide its cards with a click, Enter, or Space. The board remembers expanded and collapsed groups on this browser for each grouping choice and workflow lane. With single-key shortcuts enabled, press **C** while the board has focus to toggle all its visible groups.

Open **Group by** on Household or a named Board. **By Area** uses the task’s Area, including the Area inherited from its Project. **By Epic** groups an Epic card under its own name. Other cards use their nearest readable parent Epic, even outside the current filter or page. Cards without a readable Epic appear under **No Epic**. Epic headings sort by name and include the Board’s ticket key to distinguish matching names. Group counts reflect the current page of each lane. Close Details after changing a parent to see the card in its new group. Copy the Board URL to preserve the grouping. Switching between Kanban and Table preserves Epic grouping.

The work-in-progress count uses all eligible cards in the lane. Reordering a card preserves the relative order of all other cards across area filters and overlapping custom lanes. After a move, the destination lane may show a different page from the one containing the moved card.

Dates due today appear in amber. The light palette uses a darker shade on white cards, including when Auto selects light. A due date without a time is a calendar day in the timezone set in **Settings → Language & Time**. The relative format shows it as today, tomorrow, yesterday or a number of days, weeks or months. Absolute formats keep the same day in every timezone.

### Switch task views and keep the current query

1. Apply the Kanban filters you need.
2. Use the route-level view pills to move to Calendar, Table, or Timeline.
3. The route preserves the existing filters. A valid `view` query parameter controls the view even when the fragment changes. When the query omits a view, the browser still honors a legacy fragment such as `#calendar` after loading. Label names with commas or brackets keep their literal spelling when shared from Table to Kanban. Kanban uses the compatible board filters. Apply a full saved Table preset in Table to use Table grouping, columns and nested rules.

Select **No grouping** from a grouped board before copying a link to the flat board. Opening that link shows the flat board even in a browser that has saved a different grouping preference.

On mobile, use the Task views below the toolbar actions. Open **More** if a view does not fit. The bottom app navigation opens Tasks, and the in-page links switch between Kanban, Calendar, Table, and Timeline.

Older Tasks bookmarks and sidebar shortcuts that specify a hierarchy type such as `task_type=story` open directly in Table when they omit both the view query and fragment. Plain Tasks still remembers your last view.

On wide screens **New Task**, **Search Meitheal**, and **Ask Home Assistant** sit at the upper right. The row below holds **Deferred**, **Inactivity**, **Fields**, and **Lanes**. On phones, open **Board actions** to reach that group. The first two links carry the current area to their respective views. If an area was deleted, returning from Deferred keeps that scope visible as **Unavailable Area**. Choose an available area or **All Areas** from the area menu before adding a task in a lane.

### Filter and group Timeline

Use Tab to move between visible task views. If a view moves into **More**, open that control and use the arrow keys to choose it.

Open **Timeline** to narrow the chart by text, status, priority, task type, or area. Use **Group by** to organize dated tasks. The URL keeps these choices when you reload or move between task views. On phones, open **Filters** to adjust the chart. The task pane starts closed unless you saved a preference. Select **Task pane** to open or close it. The control becomes available when tasks match the filters.

Timeline omits empty optional values from its initial task data to reduce download and parsing work. Missing dates still place the task in the undated work list when applicable. The Area field keeps the distinction between Default and unavailable Areas.

When you group by **Project**, each project has its own section. If project names match, the heading adds the project's Area when available. A project with no direct Area inherits its linked Goal's available Area. If a direct Area reference is unavailable, its group uses a stable qualifier until that reference is repaired. **No Project** contains unassigned tasks. **Unknown Project** contains tasks whose assigned project is unavailable. Open **Task pane** to see the groups. Use Tab to reach a group button and Space or Enter to collapse or expand it. Use the Up and Down arrows to move between bars and group buttons. Collapsed groups stay collapsed while you filter the chart.

When you group by **Area**, different Areas have separate rows even when their names match. A short reference distinguishes matching names. You can collapse each group independently and its state survives filtering. Tasks with unavailable Area information appear under **Unknown Area**.

Timeline loads Project and Group labels according to your organization access. On Household and named Boards, tasks you can view retain their **Unknown Project** or **Unknown Area** grouping when a reference becomes unavailable. Timeline omits unavailable identifiers and names from its chart data.

### Group cards by assignee

Choose **Group by → By Assignee** to see who owns the cards on each workflow column page. The column total counts the full result. **Unassigned** contains tasks with no assignee. When different people or unavailable assignments share the same label, a number distinguishes their headings. Their cards and collapse preferences stay separate.

If the Home Assistant roster cannot be verified, the board shows a cached name when one is available from the same connection. Otherwise it shows that the assignee could not be verified. Reload the board to check the directory again. Choose **Unassigned** from a card's **Assign User** control to move it into that group in the same workflow column.

### Group cards by status

Choose **Group by → By Status** to split each workflow column into status groups. Each heading counts the cards on the current page. The column total still counts the full result. Overlapping columns keep their own cards. Changing only the grouping keeps the current page. Changing a filter starts at page one.

Use Enter or Space on a heading to collapse its cards. A status group remembers its collapsed state separately in each column. Sharing the URL includes the grouping and current column page.

### Group cards by project

Choose **Group by → By Project** to split the current column page into project groups. Separate projects with the same name have separate groups. A second heading line shows the project's Area when it helps distinguish the name. Projects with no direct Area can use their Goal's Area.

**No Project** contains tasks with no project. **Unknown Project** contains assignments that are unavailable to the Household. If project names fail to load, the board explains why assigned tasks are in Unknown Project. Reload to check again. Column counts and cards remain available while names are unavailable.

Use Enter or Space on a heading to collapse its cards. Each column remembers its own project groups. Changing only Group by keeps the current page.

## Troubleshooting

### Board pages or filters fail to load

The existing cards stay visible while Meitheal loads the requested page or applies a filter. Use **Retry board** after an error. If it repeats, check the browser network log for the Tasks request and confirm the URL retains its ingress prefix.

### An assignee is unavailable

**Assign User** shows **No users configured** when the directory is empty, including standalone installations without a Home Assistant connection. If the Home Assistant roster could not be verified, check the connection in **Settings → Connected Services** and use **Retry**. Standalone connections need both a URL and a token. Any custom users and cached names from that Home Assistant connection remain available while the roster recovers. Table resolves the same display names after a page or filter change. If a name is unavailable, open Details to check the assignment.

In Details, you can edit the task while the assignee directory loads. The **Assignee** field stays locked until the directory loads successfully. If loading fails, the saved assignment is preserved. Reopen Details to try again.

### A task stays in its original lane

Check the message after the move. If the destination is at its work-in-progress limit, free a place before retrying. If dependencies are blocking progress, open the task and check its linked work. If the connection failed, refresh to confirm the saved lane before trying again.

### A quick capture appears to fail

The form keeps the title. Check the area selection and destination lane. If you lost the connection during the save, verify whether the task already exists before retrying.

### Board updates fail behind ingress

1. Inspect the browser console for `kanban` client logger warnings.
2. Confirm client fetches are using bare `/api/...` paths and not double-prefixed ingress URLs.

### Lanes does not open

1. Confirm `#lane-mgmt` drops the `hidden` class after opening **Lanes**.
2. If the button responds but the panel stays hidden, capture the browser console and the current filter state.

## Card colors

Use **Set card color** to choose the task color. Knight Rider tints the whole card while keeping the active-work indicator visible. Other palettes use the color at the card edge. Saving and reloading retain that choice. **Clear color** restores the default treatment. Rejected writes retain the saved color and report an error so you can retry. A Board refresh from a Details status save waits while you edit an inline title or draft. If the Board cannot refresh after a successful Details status save, it keeps its last loaded lane and card state and offers Retry.

In the color picker, use Up and Down to choose a swatch and Enter to save. Focus returns to the card’s **Task actions** button during the save and after the board refreshes.

Cards keep their full height in a busy lane. The lane scrolls instead of
compressing the cards. At widths from 769 to 1024 CSS px the sidebar narrows to
200 px, and the page content starts at the sidebar edge. Both read
`--sidebar-width`, so a change to one width moves the other.

The browser can skip laying out Household cards outside the viewport and reuse measured card sizes during an in-place refresh.

An unreadable card assignment no longer interrupts grouping for the board. Check the assignment in Details if its group is unexpected. If an assignee group disappears after a refresh, keyboard focus returns to its workflow lane heading.

Kanban Project groups keep their saved collapse state when their names change. Duplicate or reserved names show a short identity token before the Area, so long names cannot hide the distinction. Missing and unavailable assignments use the current language’s labels. If a focused Project disappears after a refresh, focus returns to its workflow lane heading.

When reopening Details from a card or ticket link while a Board Group save is pending, the drawer waits for that save and then reads the current task. A later edit from another client remains authoritative.

Timeline Project headings show a short identity token before the Area for duplicate or reserved names. Missing and unavailable assignments use the current language’s labels. Scrolling away and back keeps Sidebar rows in visual keyboard order.
