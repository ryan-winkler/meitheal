---
type: Guide
title: "Triage household tasks"
description: "Review Backlog tasks and move them to Todo or In Progress."
---

# Triage household tasks

Open **Planning → Triage** to review Backlog. The live queue loads in the tab and shows the oldest tasks first, 25 at a time. **Details** opens the shared task panel. **Accept to Todo** commits to a task without starting it. **Start now** puts it in progress once its dependencies allow it. The card leaves the queue after the server confirms the decision.

Due dates use the selected app language and keep the stored calendar day when you change time zones.

Use Tab to reach the card controls, Enter to activate them and Escape to close Details. Closing Details returns focus to its link. After a saved decision, focus moves to the next available card or the queue heading. To return a task to intake, move it to the built-in Backlog lane in Kanban while Backlog is Visible.

In Settings, **Visible** makes Triage available. **Hidden** removes the built-in lane and hides the queue. Review remaining Backlog tasks in Table. **Disabled** also removes Backlog from the status choices. Reopen Triage after changing modes.

Triage needs a network connection so its counts and decisions are current. If an older worker is controlling Triage, choose **Reload Triage** to activate the waiting update or fetch a fresh copy. The worker gets its ingress path from the registration scope before precaching. Legacy Areas and Projects links still open Planning inside the same ingress scope. Planning can still show an earlier snapshot offline.

- If **Start now** reports dependencies, open Details to review them.
- If a decision times out or the task has changed, reload Triage and check the task before retrying.
- If you open Details during a save, finish reviewing it and use the **Reload Triage** link to reconcile the queue.
