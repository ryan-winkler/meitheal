# Routine check-ins and recurring Tasks

A Routine is a saved template that generates ordinary Tasks on its Board. It can stand alone, belong to an Area, or reference a Project. Disabling the Project or Organizer catalogue does not disable otherwise permitted standalone Routines. The Routine list checks only its referenced Project's current lifecycle when offering check-in; it does not require loading the Project catalogue. Completed or archived Projects do not advertise a new check-in. An already completed occurrence can still acknowledge its own retry.

Checking in requires current Routine visibility and Task creation and completion permissions. Editing the Routine configuration is a separate action. A child who cannot complete Tasks cannot create a completed occurrence by checking in. Deleting a Routine acknowledges the committed removal after access is refreshed; repeating the deletion reports that the Routine is unavailable.

The command checks the saved template, cadence and period in its actual writer and again before commit. If another user changes cadence while a check-in is in flight, or the period changes before commit, no stale occurrence or ticket number is allocated. Refresh and check the displayed period before retrying. Retries of the unchanged current occurrence reuse that Task.

Task recurrence can be edited from the existing Task inspector/API. A valid `recurrence_rule` replaces the old rule; `null` or an empty string clears it. Invalid types, unsupported frequencies and overlong rules reject the whole patch. Supplying the Task's current `updated_at` version preserves conflict protection. The next genuine completion uses the newly saved rule; clearing it stops successor generation.

Selected Area/Project backlog pages filter before totals and paging. An Area includes Tasks whose owned Project belongs to it even when the Task has no direct Area. Unfiled Projects retain their own selected context. Table Tasks carry a normalized numeric version for edits, including historical SQLite timestamps.

Project grouping qualifiers use current visible Area metadata. A Goal's Area can qualify a Project only when its direct Area is absent and the Goal and Area are visible on the same Board. Hidden, retired or foreign associations do not become fallback labels. A masked Area assignment uses the same neutral no-Area label as unfiled work.

Validation: `tests/e2e/ordinary-work-r52-routines.spec.ts` covers both Board storage encodings, current HTTP handlers, deterministic cadence races, permission denial, recurrence persistence/clearing, scoped backlog totals, metadata privacy, normalized versions and custom-lane ordering. Release verification still requires the repository's full CI and applicable runtime tiers.
