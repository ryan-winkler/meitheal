---
type: "Guide"
title: "Kanban Shell Guide"
description: "Understand the board layout and task controls."
---

# Kanban Shell Guide

Open **Tasks** and select **Kanban** to see the board. The area picker, task filters, SearchHub, Assist, lane management, and new-task controls sit above it.

## Common Jobs

### Work in an area

Use **All Areas** above the board to select a specific area. The card and lane counts follow that selection and the task filters. **Add Task** at the bottom of a lane captures a task in the selected area and lane. Press Enter or choose **Add** to save. If the save fails, the form keeps the title available for retry. **Cancel** or Escape closes the form.

### Move or open a card

- Select the card's task key, such as **MTH-42**, to open the full task. With a task key focused, use Up and Down within a lane, Left and Right between lanes, and Enter or Space to open. Press N to open quick capture in that lane.
- Open **⋯** at the top of a card and pick a lane under **Move to**. This works with keyboard, mouse, or touch. Escape closes the actions and returns focus to the card. To reverse a move, choose the previous lane.
- You can also drag the card. On touch, hold the card body briefly before moving it. The card stays in its current lane while Meitheal saves. A rejected move leaves it in place.

The task key is part of the card button’s accessible name. When one quick action replaces another, only the current dialog accepts keyboard input.

Quick actions sit below the task details and wrap within the card. They stay visible on narrow screens and touch devices. On desktop, hover over the card or move keyboard focus into it to reveal them.

Tab and Shift+Tab stay inside task detail while it loads and while you edit. Press Escape to close it and return to the card. When a confirmation is open, Escape dismisses the confirmation first.

### Promote a card

Open a card’s **Task actions** and choose **Promote to top** to move it above ordinary cards in the same lane. Everyone using the board can see the **Promoted** badge. Use **Promoted only** to filter the board, and bookmark the resulting URL to reopen that filter. Work-in-progress counts still include all cards in the lane.

Choose **Remove promotion** from the same menu to return the card to its normal position. Promotion leaves the task’s priority and favorite setting intact. Drag to reorder within either group, or move a card to another lane to carry its promotion with it.

### React to a task or comment

Open a task and select **Task reactions**, or use **Comment reactions** beside a comment. With a verified Home Assistant identity, you can add an emoji or up to 16 characters of text and remove your own reactions. If saving fails, your draft remains available to retry. Choose **Older reactions** to see earlier entries.

A card's reaction count covers the task itself. Open the task to see who reacted or to read reactions on its comments.

### Manage lanes without leaving the board

1. Open `Kanban`.
2. Use the shell `Manage Lanes` action.
3. Keep the board visible while editing lane structure and WIP limits.

### Change card density without fighting the shell

1. Open **Fields**.
2. Use the card customizer there instead of expecting field toggles in the shell.
3. Compact density hides secondary card rows such as description, metadata, labels, progress, and custom fields so dense boards stay scannable.
4. Close **Fields** to return to the board.

### Page through a large board

Each lane shows up to 25 cards. Its count includes every task matching the current area and filters. The range below the lane shows which cards are loaded. Use **Previous** or **Next** to page within that lane. Use **Filter by text** or the filter builder to find a task anywhere in the board, including other pages. Changing the area or filters returns the lanes to their first page.

Open **Overdue** from Dashboard to filter tasks across every Kanban page. The board matches Dashboard’s due-date and completion rules.

The work-in-progress count uses all eligible cards in the lane. Reordering a card preserves the relative order of all other cards across area filters and overlapping custom lanes. After a move, the destination lane may show a different page from the one containing the moved card.

Dates due today appear in amber. The light palette uses a darker shade on white cards, including when Auto selects light.

### Switch task views and keep the current query

1. Apply the Kanban filters you need.
2. Use the route-level view pills to move to Calendar, Table, or Timeline.
3. The route preserves the existing filters and adds a `view` parameter for Table, Calendar, or Timeline. Existing hash bookmarks still open their view. The server loads the selected view when you open it. Label names with commas or brackets keep their literal spelling when shared from Table to Kanban. Kanban uses the compatible board filters. Apply a full saved Table preset in Table to use Table grouping, columns and nested rules.

On mobile, the view pills remain as a horizontal touch strip below the unified bar actions. The bottom app navigation opens Tasks, while the in-page strip switches between Kanban, Calendar, Table, and Timeline.

On narrow screens the task type filters use two rows. Board cards and table rows appear as soon as the view renders, including when the device requests reduced motion.

### Filter and group Timeline

Use Tab to move between visible task views. If a view moves into **More**, open that control and use the arrow keys to choose it.

Open **Timeline** to narrow the chart by text, status, priority, task type, or area. Use **Group by** to organize dated tasks. The URL keeps these choices when you reload or move between task views.

## Troubleshooting

### Board pages or filters fail to load

The existing cards stay visible while Meitheal loads the requested page or applies a filter. Use **Retry board** after an error. If it repeats, check the browser network log for the Tasks request and confirm the URL retains its ingress prefix.

### A task stays in its original lane

Check the message after the move. If the destination is at its work-in-progress limit, free a place before retrying. If dependencies are blocking progress, open the task and check its linked work. If the connection failed, refresh to confirm the saved lane before trying again.

### A quick capture appears to fail

The form keeps the title. Check the area selection and destination lane. If you lost the connection during the save, verify whether the task already exists before retrying.

### Board updates fail behind ingress

1. Inspect the browser console for `kanban` client logger warnings.
2. Confirm client fetches are using bare `/api/...` paths and not double-prefixed ingress URLs.

### Manage Lanes does not open

1. Confirm `#lane-mgmt` drops the `hidden` class after clicking `Manage Lanes`.
2. If the button responds but the panel stays hidden, capture the browser console and the current filter state.

## Card colors

Use **Set card color** to choose the card edge accent. Saving and reloading the board retain that choice. **Clear color** restores the task type accent. Rejected writes retain the saved color and report an error so you can retry.

In the color picker, use the arrow keys to choose a swatch and Enter to save. Focus returns to the card’s **More actions** button during the save and after the board refreshes.
