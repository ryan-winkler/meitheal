---
type: Guide
title: "Task references, cancellation and compatibility capture"
description: "What to expect when access changes while tasks or Routines are being edited."
---

# Task references, cancellation and compatibility capture

Task hierarchy and planning history remain stored when related work becomes private or retires. Public task responses include a parent only when the current reader can access that parent. Hidden parent identifiers are omitted from task detail, lists, Board views, Timeline and exports. Area, Project and Goal references follow their existing current visibility rules. These public omissions do not erase historical relations or change the references used for authorization and task commands. New parent assignments also check the Board’s physical ancestry, so an ancestor becoming private cannot permit a hierarchy cycle. That check returns no hidden identifiers or content.

Task dependencies created through related-task links require both endpoints to be readable. The separate free-form blocked-by note is user-entered content and is preserved as written.

Routine edits and retirement recheck the actual current template placement inside their writer. If someone moves a Routine into an Area or Project that you cannot access while your request is waiting, that request cannot move it back or retire it using its earlier public placement. Refresh before retrying.

Cancellation or a write deadline during an acquired task update rolls back the task edit, completion or assignment together with its activity, recurrence successor and receipt effects. Once a commit has begun, a lost response can still be uncertain: reload the task or use its existing receipt before retrying.

The older `/api/tasks/create` route accepts an object `frameworkPayload` and uses its description when no explicit description string is supplied. It delegates to the same scoped task command as `/api/tasks`; the explicit description takes precedence and the normal sanitizer still applies. Its response retains the `{ task, events, integration }` envelope. `events: []` means that this response contains no synchronous integration event receipt. Calendar synchronization remains asynchronous and follows approved source bindings; an integration state of `pending` does not confirm delivery. The adapter does not invent a confirmation or start a second creation or integration pipeline.

The earlier Board `/tickets` list and creation routes retain `ticket` and `version` aliases for their disclosed canonical fields. Use the returned version for a guarded edit. A create-only receipt keeps its minimal acknowledgement; the adapter does not add a version or private task fields that the canonical response withheld.
