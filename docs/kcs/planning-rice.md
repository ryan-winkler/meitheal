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

Open a ticket and choose **Scoring framework**. Formula scoring supports field keys with numeric estimates, decimal constants, parentheses, unary signs, and `+`, `-`, `*`, `/`. Existing RICE arithmetic and rounding are unchanged. Framework configuration can retain other expressions, such as exponentiation or function calls, but the ticket editor reports **unsupported formula** for those expressions and unknown field keys. Edit the formula in Settings to use the supported arithmetic before saving an evaluation. Invalid estimates, including division by zero, produce an estimate error instead.

**Auto-score with Assist** merges the returned suggestions with your current estimates. Fields omitted from the response keep their values, including edits made while waiting and estimates in another framework you switched to. Review suggestions before choosing **Save score**.

A failed save keeps the visible estimates. Saves use the task's normalized version even for older timestamp formats, so a competing update cannot silently overwrite another evaluation. Reopen the ticket to review current saved data before retrying after a conflict.
