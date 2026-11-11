---
type: Guide
title: "Rank work with RICE"
description: "Edit reach, impact, confidence and effort directly in Planning."
---

# Rank work with RICE

Open **Planning → RICE**. **Ranked work** shows the highest scores first. **Needs a score** shows open tasks without a score. Completed and deferred work stays out of both lists. Use the paging controls to find more tasks.

Choose **Edit score** beside a task and enter Reach, Impact, Confidence as a percentage, and Effort in a consistent unit. The score updates as you type. Use an effort greater than zero. **Save score** refreshes the ranking, confirms the save, and returns keyboard focus to **Edit score** for the task. If the task moved to a different page, focus moves to the RICE heading.

Tasks with older saved estimates keep their existing scores. Saving an edit stores the new numeric estimates alongside the original fields.

If another session changes the task while the editor is open, choose **Reload score** and review the latest estimates before saving. If a request is interrupted, check the latest score before trying again.

## Score a ticket with another framework

Open a ticket and choose **Scoring framework**. Formula scoring supports field keys with numeric estimates, decimal constants, parentheses, unary signs, and `+`, `-`, `*`, `/`. An unchecked box counts as 0 and a checked box counts as 1. Invalid estimates, including division by zero, show an estimate error.

The editor keeps estimates for a framework with unsupported scoring settings. Ask an administrator to export the configuration from **Settings → Rules & Lenses**, correct the formula, bounds, or options, and re-import it. Built-in frameworks can also be reset to their packaged defaults. See [Import a framework from YAML](framework-yaml-import.md).

**Auto-score with Assist** applies valid suggestions only to fields you left untouched while waiting. Switching frameworks or saving another score keeps your unsaved estimates. Review the suggestions before choosing **Save score**.

A save merges unrelated frameworks from the latest task. If another session changed the same evaluation, the editor keeps your draft and asks you to reopen the ticket. Note any estimates you want to keep before reopening so you can compare them with the saved values.
