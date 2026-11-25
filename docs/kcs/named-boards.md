---
type: "Guide"
title: "Boards, Areas and Projects"
description: "Keep connected work in its context, with separate sharing and task permissions."
---

# Boards, Areas and Projects

A Board holds a body of work and the people allowed to use it. Household is an editable example, just like Work, House or Church. Every Board provides the same task types, views, planning and progress features, subject to your permissions and enabled features.

Open **Boards** to choose or create a workspace. All your Boards appear together. Expand a Board in the sidebar for its Areas and Projects. **Hide from my sidebar** changes your shortcuts; it does not change membership or privacy. Reopen a hidden Board from the directory.

An Area name opens the Area. Its adjacent **Projects** disclosure expands the Project list. On phones, selecting Rename or Delete keeps the drawer open so you can edit, confirm or cancel in place. Opening a pinned capture type also keeps the drawer open and closing the form returns focus to the same shortcut. Use **All Areas** in the Board header to filter the current view. The picker stays within the viewport when the header wraps on a narrow screen. In the **Tasks** submenu, pin a view to add it to navigation. Each pinned view has one unpin button.

When creating a Board, you can choose workflow labels. Presets change labels on its four existing task statuses; they do not change task behavior, permissions or Routine completion. The choice applies to that Board for all members. [First-time setup](first-time-setup.md) controls personal preferences.

The selected Board stays with Dashboard, Today, Upcoming, Tasks, planning and progress. On Today, the page, mobile navigation and sidebar share the same authorized Board selection for the current request. Sidebar Area preferences govern whether Area links appear and what label they use. The Board and Area menus include rename, icon and color, pin, and remove actions where the current Board grants them. Sidebar task-view shortcuts always open the task workspace; Upcoming empty actions, Triage pagination and achievement links keep the same Board and selected Area or Project. Calendar day details are reads, so a Viewer can open permitted work without task creation rights. Use Kanban, Table, Calendar or Timeline for the same work. On phones, the bottom navigation highlights Calendar when you open it on a Board. Tap Tasks to return to the same Board's Kanban. Task capture, including Quick Add, keeps the selected Area or Project. With no selected Area or Project, new work stays unfiled; no Area is invented. Keyboard shortcuts and the Dashboard queue keep the same Board and placement. Check the visible Board name before saving. An unfiled Project can hold tasks without an Area.

Hierarchy controls use the current Board and record permissions. Before restricting a Board or disabling shared administrator management, retain an active explicit owner so it stays manageable.

## Organize and connect work

Planning and Progress keep the selected Board, Area, or Project. Use the Progress section controls to switch between Goals and Routines, and use the Back to Board link to return to the same selection in Kanban.

Use **Areas & Projects** to group related work. Group labels use only visible associations; unfiled or unavailable Area metadata uses the same neutral “No area” label. An Area can be Kitchen, Yard or any name you choose. A Project can associate with an Area. Organizing Areas and Home Assistant physical locations are separate fields: changing a physical location does not refile work or change its audience.

Open an Area or Project for its tasks, Goals, Routines and settings. Contextual creation retains that association. Empty pages expose the relevant creation actions when you have permission. Existing links continue to open the same records.

Goals can associate with Boards, Areas and Projects. A Goal shared into Home shows the progress from Projects each reader can access. Private Work Projects, their names and their contribution to totals remain hidden from Home readers without Work access. Share into the receiving contexts where the Goal should appear; sharing into a whole Board does not automatically associate it with every Area and Project.

Completed Goals show a labeled status badge with a theme-aware text color for light and dark surfaces.

Routines use the same templates and occurrence history on every Board. They can be Board-only, associated with an Area, or associated with an unfiled Project. Completing a Routine follows task creation and completion permissions. Existing generated chores remain ordinary tasks; changing Routine configuration does not erase their history. A retry for an already completed occurrence retains its original task. If you try to change its date through a Board ticket, the response explains that the generated task keeps its original occurrence date.

Pillars can belong to a Board or remain personal. **Only me** keeps a personal Pillar private to its verified owner. Board-owned Pillars and Principles follow the selected Board and its audience controls.

## People and actions

Open **Board settings** to change the Board name and sharing, manage people, and configure send-only destinations and restrictions. The example Board uses these same controls. Pending changes retain your inputs and ask for a refresh before another submission. Viewers read permitted work. Members create and update permitted work. Owners manage access. Ownership does not override a restriction on completion or deletion.

Completion and deletion are separate. A child can be allowed to move and update tasks while marking done and deleting remain blocked. Agent deletion restrictions remain effective even when the credential has a deletion scope. Giving someone a task does not grant access to the Board that holds it. When delegating by name, a unique current directory identity is required. An ambiguous or unavailable name asks you to use an exact identity ID; it does not save the name as an assignee.

An owner can create a send-only destination with allowed senders, a triage column and an optional recipient. The sender uses **Send a task** without receiving access to other tasks, Board counts or private planning content. Keep the original submission when retrying after a timeout. A receipt confirms that submission; it does not grant task read.

After a Goal share or intake change, the API confirms the committed change against the new access revision. The confirmation contains only the outcome, or the new intake's ID for a creation. If publication is still pending, refresh the Board before retrying.

**Delete Board** keeps its saved work in Deleted Boards and pauses incoming work. **Restore Board** uses current permissions and returns the same identities. Personal hiding and Board deletion are different actions.

## Integrations and automation

In **Board settings → Integrations and automation**, choose an existing source and its destination. An external source requires a Home Assistant administrator who can manage the destination Board. Local Board rules require Board management. Choose optional Area/Project placement and the task actions the source may perform. Private mobile notifications require explicit eligible recipients.

Renaming a Board does not retarget a source. Missing, retired or denied destinations pause work. They never silently use a different Board. Changing a global Calendar, CalDAV, Grocy or webhook profile requires management of every affected Board and invalidates pending operations against the old approval.

Home Assistant integration credentials select an explicit Board. Global HA entities, shared events and logbook cannot expose private Board tasks or counts. A human action also needs that person's current Board permission; an automation's broader configured credential does not grant the person more access.

Task deletion can notify an approved Home Assistant event or webhook receiver even if the task never came from a sync source. The receiver must have matching Board and placement approval when the task is deleted. Changing or disabling that approval cancels any pending delivery.

## Refresh, offline work and recovery

A concurrent change asks you to refresh rather than overwriting another person's work. Inspector and Table deletion use the loaded task version too. Table inline and bulk edits keep unconfirmed inputs for review instead of overwriting a newer task; a partially successful bulk action reports only confirmed changes. A pending delete confirmation is canceled when its Board is hidden for verification or access is revoked. Unchanged verification allows a fresh confirmation, while the old confirmation stays canceled. Legacy Board links with `?ticket=` open the same inspector. Page entrypoints handle access failures and planning redirects before rendering their embedded views. If access fails later, embedded panels show an unavailable/retry message. A deleted or unavailable task permalink opens an empty recovery shell with the shared inspector; closing it returns to task navigation without showing another Board's work. Proposed Timeline dates stay available after an unchanged focus verification; review or explicitly discard them. Temporary verification failures hide private content and retain eligible drafts. Confirmed revocation discards the open inspector and its unsaved draft. The inspector hides unavailable completion and deletion actions. Its status menu disables transitions that the Board does not permit. A switched account cannot inherit another person's offline queue.

Offline editing uses the existing actor/installation/Board queue. Work pages, APIs and capture receipts require current network verification. The static offline screen contains no personal tasks. A missing capture acknowledgement remains unconfirmed: check the original attempt when connected before creating another task.

Use a cold Home Assistant App backup for the instance's database, committed grant marker and App options. The archive excludes the transient pending publication journal. Governed restore also requires a separately retained current operator checkpoint. Follow [Home Assistant backups and restore](home-assistant-backup-and-restore.md) and the release runbook for current custody, stopped-App verification and recovery.

Retiring an Area, Project or Goal preserves historical associations in storage. Public task responses omit unavailable planning references; they do not expose a private or retired destination as an active selection. A successful retirement acknowledges its own committed change while stale readers must refresh.

A Board directory retains the same verified person and grant revision across its Boards, send-only destinations and Deleted Boards. If authority changes or that identity proof expires while the page loads, the entire directory is withheld and asks for a refresh; a newer current revision cannot admit older private names. The final HTTP boundary completes asynchronous directory rendering, ordinary work pages and compact task refresh fragments before admitting private content. Each keeps its original verified identity, required Board scopes and grant revision through ingress rewriting. A later Layout check cannot substitute newer authority for an older task projection. Revocation or expiry during rendering withholds the entire response and asks for a refresh.

Board admission reads the role and Board-wide audience together and evaluates all required effects against that policy. Task and placement queries enforce their own audiences, and the final boundary checks current authority. A private task writer on local SQLite keeps human captures and edits in the transaction until it rechecks every required action and commits. A changed agent assignment requires fresh task-write authority. Today and the common Task views reuse compiled projection statements on native SQLite. Each request binds its own filters and reads its own snapshot.

Existing `?board=` bookmarks and `?board_id=` links select the same workspace. If both appear they must agree with each other, the Board header and any Board path. Empty, repeated, conflicting or unavailable selectors show an unavailable response rather than selecting the capture default.

Task references to Areas, Projects and Goals also respect each feature's current visibility. Hiding a feature removes its public reference IDs without erasing stored task associations or granting planning permissions to task-only agents.

Grant and lifecycle changes retain their originating verified identity through durable journal preparation. An expired identity rolls back the change and its proposed epoch. An intentional removal of the caller's old Board entitlement can still succeed while the independently verified identity remains current; refreshing an old permission is not a substitute for either check.
