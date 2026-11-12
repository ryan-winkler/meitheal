---
type: Runbook
title: "Task completion results"
description: "Understand committed completion rewards and optional failures."
---
# Task completion results

Complete a task through `PUT` or `PATCH /api/tasks/{id}`. The server reads the prior status and saves the mutation in the same writer transaction. Only an actual transition into a completed status earns completion statistics, emits the completion event and starts recurrence processing. Concurrent requests or repeated writes to an already-complete task do not earn additional points. Existing version, checklist and dependency guards still apply.

The acknowledged task response may include `gamification` with the earned XP, current statistics and optional celebrations. Browser callers use that result; they do not record another completion. `POST /api/gamification` is retired and returns HTTP 410. Habit check-ins and other non-task actions do not manufacture a task completion reward.

If optional statistics cannot be saved, the task still returns a successful acknowledgement with `gamification.error: "Task saved; completion statistics unavailable"`. The saved status remains authoritative. Refresh the task to resolve a lost response before retrying another action. Reopening and later completing a task is a new transition. Event dispatch is best-effort; successful persistence does not prove external subscriber receipt.

For a disposable verification dataset, complete the same task concurrently from two clients, repeat the completion, and confirm one reward. Verify a stale-version or blocked write earns nothing. Check that a statistics storage failure preserves the completed task and reports the optional failure. Check board, table, Today, Upcoming and task detail callers show celebrations only after an acknowledged earned result.
