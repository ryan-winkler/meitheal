<!-- markdownlint-disable MD024 -->

# Changelog

This file records the notable changes to Meitheal. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The text follows the [ASD-STE100](https://www.asd-ste100.org/) rules for Simplified Technical English.

Meitheal has two release channels:

- **Meitheal Canary** gets each qualified build from `main`. The version of a Canary build is the first 12 characters of its source commit.
- **Meitheal** (Stable) uses semantic versions. Stable stays at `0.0.1` in this release.

## [Unreleased] — Canary from the public source, 11 November 2026

This is the first full changelog. It lists all the features in the current Canary build. The source is [ryan-winkler/meitheal](https://github.com/ryan-winkler/meitheal).

### Added

#### Install and run in Home Assistant

- **Home Assistant App.** Meitheal runs as an App (add-on) on the same device as Home Assistant. It keeps all task data in a local SQLite database.
- **Sidebar panel.** Meitheal opens in the Home Assistant sidebar through ingress. You do not need a separate account, port or password.
- **Two architectures.** The App image is available for `aarch64` and `amd64`. Home Assistant Green and other ARM64 devices use the `aarch64` image.
- **AppArmor profile.** Supervisor applies the same AppArmor profile to the Stable and Canary Apps.
- **Separate Canary App.** Meitheal Canary has its own App ID and its own data. You can install it next to the Stable App.
- **Health endpoint.** `GET /api/health` shows the version, the database state, the schema version and the Home Assistant connection state.

#### Capture work

- **Quick capture.** Type a task on Today or the Dashboard and press **Add**. Meitheal reads dates and lists in the text, for example "call the plumber tomorrow".
- **New Task dialog.** Create a task with a title, description, priority, due date, Area, Project, parent task and labels. Open more fields in **More options**.
- **Task types.** Select **Task**, **Shopping**, **Checklist** or **Routine**. Each type keeps its own data and has its own filter.
- **Checklists.** Add many checklist items in one step with the button, the Enter key or pasted lines. Each item keeps its order and its state.
- **Private drafts.** Meitheal keeps an unsent task draft in the browser. When you open the dialog again, the draft comes back.
- **Templates.** Save a task as a template and create new tasks from it.

#### Plan the day and the week

- **Dashboard.** The Dashboard shows the current signal, counters, Capture, Momentum, the Focus Queue and Recent Work.
- **Today.** Today shows overdue, due and priority tasks. It also shows the tasks that Meitheal carried forward from earlier days.
- **Evening Review.** At the end of the day, Today shows the open tasks. You can snooze all of them until tomorrow.
- **Upcoming.** Upcoming groups tasks by date. The next 48 hours are separate from the rest of the week.
- **Recent activity.** Recent activity shows the committed changes to tasks and the person who made each change.

#### Organize work

- **Areas and Projects.** Put tasks in Areas, such as Home or Garden, and in Projects inside each Area.
- **Independent sidebar sections.** You can collapse the sidebar and the Areas list separately. Each Area link opens a board for that Area only.
- **Goals.** Link Projects to a Goal. Goals show the progress of their Projects.
- **Pillars and Principles.** A Pillar records a long-term reason for your work. Each Pillar has Principles. You can mark a Principle as Non-Negotiable.
- **Routines and Habits.** A Routine creates new task instances on a schedule. Habits show the next occurrence and the current streak.
- **Recurrence.** A task can repeat. The next instance keeps the checklist items of the earlier instance.
- **Dependencies.** A task can wait for other tasks. Meitheal keeps the dependency direction that you save.
- **Subtasks.** A task can have a parent task. The board and the Table show the hierarchy.
- **Labels.** Create, rename and delete labels in **Settings → Workflow → Labels**. The label manager finds a label in a large list.
- **Custom fields.** Add your own fields to tasks in **Settings → Workflow → Custom Fields**.
- **Pinned tasks.** Pin a task to keep it near. Pinned tasks appear in the sidebar and on the Dashboard.
- **Comments, mentions and reactions.** Add comments to a task, mention a household member and add reactions. Only the author can edit a comment.

#### Task views

- **Kanban.** Move tasks between lanes with drag and drop or with **Move to** in the task actions menu. The task actions menu also works on a phone.
- **Lanes.** Configure the lanes and a work-in-progress limit for each lane. Group the board into swimlanes by type or by another field.
- **Card details.** Each card shows the task key, the type, the title, the priority, the due date and the checklist progress.
- **Card colors.** Set an edge color for a card. **Clear color** restores the color of the task type.
- **Table.** The Table shows tasks in rows of 50, with sort, filter and group controls. You can edit a title in the row.
- **Household filters.** Filter the Table by workflow column, by assignment and by creation date.
- **Calendar.** Calendar shows tasks on their due dates by month. It stays inside Home Assistant ingress.
- **Timeline.** Timeline shows scheduled tasks as bars on a time scale. Unscheduled tasks appear in a separate list.
- **Saved filters.** Save a set of filters as a preset and open it again from the board, the Table or Search.
- **Task links.** Each task has a link that uses its ID. The link stays correct after you change the title or move the task.
- **Deferral.** Defer a task to a later date. The board shows deferred tasks separately.
- **Inactivity.** The board marks tasks that did not change for a long time.

#### Decide what is important

- **Planning.** Planning collects the tasks that you can triage or score. An empty queue tells you the next step.
- **Triage.** Triage lets you classify new tasks one at a time.
- **RICE score.** Give a task a reach, impact, confidence and effort value. Planning and the task views use the same score.
- **Eisenhower Matrix.** Sort tasks into four quadrants by urgency and importance. Meitheal keeps the scores when a task read fails.
- **Weekly Review.** Weekly Review shows the work of the week and the tasks that need a decision.
- **Rules and Lenses.** Apply a preset, assign a framework and configure the framework fields in **Settings → Rules & Lenses**.

#### Do the work

- **Task details.** Open a task to edit its fields, checklist, notes, relations, progress and time. Destructive actions ask for confirmation.
- **Complete and reopen.** Complete a task from Today, the board or the task details. You can reopen a completed task.
- **Focus.** Today shows up to three Next tasks to focus on.
- **Pomodoro timer.** Use a work timer on a task.
- **Reminders.** Set a reminder for a task.
- **Achievements and streaks.** Progress & Growth shows completions, streaks and achievements.

#### Find things

- **Search.** Press `/` or `Ctrl+K` to open Search. Search finds tasks, views, settings and actions in one list.
- **Keyboard shortcuts.** Single keys open views and actions, for example `n` for a new task and `?` for the shortcut list. You can turn off single-key shortcuts.
- **Link previews.** A link in a task shows a preview. Meitheal gets previews only from public addresses, with a size limit.

#### Personalize

- **Customize appearance.** Select the page and navigation colors, accent, font, theme base, corner shape, content width, header, navigation style, panel style and sidebar behavior.
- **Auto theme.** **Auto** uses the Home Assistant appearance when it is available. Otherwise it uses the appearance of the device. **Light** and **Dark** override Auto.
- **Languages.** The interface is available in English and Irish (Gaeilge).
- **Regional settings.** Set the timezone, the first day of the week and the date format.
- **Sidebar configuration.** Show, hide, rename and reorder sidebar items.

#### Connect to Home Assistant

- **Home Assistant integration.** The optional integration adds a to-do entity, task sensors, binary sensors, device triggers, diagnostics and repairs.
- **Actions.** The integration adds the `create_task`, `complete_task`, `complete_task_by_tag`, `search_tasks`, `get_overdue_tasks`, `notify_overdue` and `sync_todo` actions.
- **Scoped credentials.** An administrator gives the integration a scoped Meitheal token. If Meitheal refuses the token, Home Assistant asks you to authenticate again.
- **Assist.** Assist can add, find and complete tasks through `todo.meitheal_tasks` when you expose the entity.
- **Read-only LLM API.** On Home Assistant Core 2026.11 or later, an administrator can give a conversation agent **Meitheal Tasks (read only)**.
- **To-do sync.** Sync tasks with Home Assistant to-do lists in one or two directions. The integration reads tasks in pages, so the list is not limited to the newest 100 tasks.
- **Calendar sync.** Sync tasks with Home Assistant calendars or with a CalDAV calendar.
- **Grocy.** Sync shopping items with Grocy.
- **Notifications.** Send task notifications to the Home Assistant notification list and to Companion app devices. Set reminders and overrides for each event.
- **Companion links.** Open Meitheal from the Home Assistant Companion app. The link opens the correct Settings section.
- **Connection status.** **Settings → Integrations** shows the App storage, Supervisor and Home Assistant Core states separately.

#### Automate and connect other tools

- **Webhooks.** Send `task.created`, `task.updated`, `task.completed`, `task.deleted` and `task.overdue` events to a receiver that you select.
- **n8n and Node-RED.** Use the example flows to start an automation from a task event.
- **Server-sent events.** Pages update when a task changes in another place.
- **OpenAPI and AsyncAPI.** The App serves the current API contract at `/openapi.yaml` and the event contract at `/asyncapi.yaml`.
- **Agent tokens.** Create tokens with only the scopes that a tool needs. You can revoke a token at any time.
- **MCP server.** MCP clients can use the Meitheal API as tools. A client gets only the tools that its token scopes permit. You can turn MCP off in **Settings → Automation & AI**.
- **A2A task search.** A2A 1.0 clients can search the titles of active tasks with a token that has `a2a:execute` and `search:read`. The results are read-only and include task links.
- **WebMCP.** In a supported browser, you can let a browser agent search and open Meitheal pages. When you turn WebMCP off, Meitheal removes the browser tools.
- **External AI handoff.** **Ask AI** sends a task prompt to the AI service that you select. You can read and edit the prompt before you send it.
- **Proposal review.** A Home Assistant administrator can review a text change that a scoped client proposes. Settings shows that agent handoff is a planned feature.

#### Keep your data safe

- **Exports.** Download tasks as JSON, CSV or ICS. An administrator can download the full SQLite database.
- **Settings export and import.** Export your settings to a file and import them on another device. Meitheal checks the file before it applies it.
- **Home Assistant backups.** Supervisor includes Meitheal in Home Assistant backups. Meitheal makes the database consistent before the backup.
- **Data retention.** Preview the tasks that a retention rule removes before you confirm it.
- **Reset and purge.** **Danger Zone** asks for confirmation before it deletes data. **Cancel** keeps all data.
- **Startup database check.** Meitheal checks the database integrity at startup and makes a backup before a schema change.

#### Use Meitheal on a phone and offline

- **Installable web app.** Install Meitheal as a web app on a phone or a computer.
- **Offline mode.** The service worker keeps the app shell available without a connection. It keeps up to 100 changes in a queue and sends them later.
- **Phone layout.** On a narrow screen, Meitheal uses a bottom tab bar and one vertical scroll for the board.
- **Browser notification test.** **App & PWA → Troubleshooting** sends a test notification to this browser.

#### Get help

- **Local feedback queue.** Report a problem or send feedback from **App & PWA**. Meitheal keeps the report on your device. An administrator can review it and export it.
- **Support links.** Help links open the public source repository and the public App repository.

### Changed

- **Public source.** The source and the App repository are now public at [ryan-winkler/meitheal](https://github.com/ryan-winkler/meitheal) and [ryan-winkler/meitheal-ha-addon](https://github.com/ryan-winkler/meitheal-ha-addon).
- **Canary qualification.** Each Canary image must pass a package smoke test and a benchmark on physical Home Assistant Green before publication.
- **Large task lists.** Kanban and the Table load tasks in pages. A board with 2,000 tasks stays inside Home Assistant ingress.
- **Runtime image.** The App image uses Node 26 on Alpine 3.23 and includes only the packages that the runtime needs.

### Fixed

- **Due dates.** A due date without a time is now a calendar day in your timezone. Before this change, a task due today showed "about 22 hours ago".
- **Sidebar.** The expanded sidebar no longer shows an empty Areas icon.
- **Accessibility.** The task title field and the Today complete buttons have accessible names. Each page has one main landmark.
- **Review page.** The access message on Review has sufficient contrast.
- **Kanban shortcut.** The `K` key opens Kanban. Shortcut help receives focus and lists the view keys `1` to `4`.
- **Grouped boards.** The `c` key on a grouped board collapses the swimlanes. It does not open Calendar.
- **Table titles.** A title draft in the Table stays when a refresh arrives during a save.
- **Eisenhower scores.** Eisenhower keeps its scores when a task read fails.
- **App stop.** The App stops at once when Supervisor stops, updates or backs it up. Before this change, Supervisor had to end the process after a delay.

### Security

- **Ingress authentication.** Meitheal authenticates Home Assistant ingress requests at the transport boundary. It uses Supervisor identity headers only from Supervisor 2026.10.4 or later.
- **Scoped API access.** Each API route requires the correct token scope. Retries from different callers stay separate.
- **Administrator actions.** Settings writes, database downloads and proposal review require an active Home Assistant administrator.
- **Safe content.** Meitheal removes unsafe HTML from task text and from uploaded SVG files.
- **Request limits.** The API limits the request rate and the size of request and response bodies.
- **Release images.** The release process checks the image architecture, the source revision and the image ID before publication.

## [0.0.1] — 2026-03-20

### Changed

- **Version reset** — Stable release line resets to `0.0.1` as the first proper public release. Previous `0.3.x` was dev-era versioning.
- **Two-channel release strategy** — Introduced stable + canary channels:
  - **Meitheal** (`meitheal-hub/`) — Stable, semver-versioned, vtag-triggered releases
  - **Meitheal Canary** (`meitheal-hub-canary/`) — Bleeding-edge, SHA-versioned, auto-built on every `main` push
- **stage: stable** — Graduated `meitheal-hub/config.yaml` from `experimental` to `stable`

### Added

- `meitheal-hub-canary/` — Canary addon directory with separate config, image, and docs
- `.github/workflows/publish-canary-images.yml` — CI workflow for auto-publishing canary builds
- `scripts/update-canary-version.mjs` — CI helper for canary version management
- `docs/kcs/releasing.md` — KCS runbook for the two-channel release strategy

## [0.3.1] — 2026-03-19

### Changed

- Added cross-page integration for the unified bar
- Cut a `0.3.1` patch release from current `main` to republish Home Assistant add-on artifacts

## [0.1.95] — 2026-03-08

### Added

- **`supervisor-fetch.ts`** — shared Supervisor proxy fetch with 8s AbortController timeout + auto token injection
- **`TaskRepository`** — repository pattern for all SSR task queries (335 lines, 15+ methods)
- **StatusBadge** — `backlog` + `cancelled` status support, `isDone` includes cancelled
- **CSS badge classes** — `.badge-backlog` (gray), `.badge-cancelled` (red/danger)
- **i18n keys** — `task_status.backlog`, `task_status.cancelled` in en.json + ga.json

### Security

- **XSS fix** — comment rendering migrated from innerHTML to DOM API (textContent)
- **i18n link types** — hardcoded English labels replaced with `t()` calls
- **Supervisor timeout** — 5 Supervisor proxy fetches now have 8s timeout protection

### Fixed

- **safe-fetch.ts** — 5 TypeScript errors (`string|undefined` → nullish coalescing)
- **Perf budget** — baseline bumped from 819KB to 921KB (intentional growth)
- **grocy/test.ts** — unsafe `rows[0].value` → `rows[0]?.value` optional chaining
- **tasks/create.ts** — migrated to `apiJson`/`apiError` helpers

### Changed

- 5 Supervisor proxy fetches migrated to shared utility (ha/status, ha/addons, ha-connection, grocy/test, grocy/auto-key)
- All JSON.parse calls verified in try/catch
- All setInterval/setTimeout have typed refs with cleanup

## [0.3.0] — 2026-03-19

### Added

- **Task Activity Log** — field-level audit trail for all task changes (ADR-0011)
- **Task Duplication** — `POST /api/tasks/[id]/duplicate` endpoint
- **Optimistic Locking** — 409 Conflict on stale `updated_at`
- **Rate Limiting** — 120 req/min per IP with x-ratelimit headers (ADR-0009)
- **Comment Counts** — displayed on kanban cards
- **Inline Priority Editing** — table view priority column now editable
- **Security Headers** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection, CSP
- **CSRF Protection** — origin-based checking on all mutating API routes
- **Reduced Motion** — `prefers-reduced-motion: reduce` media query
- **Toast Accessibility** — `aria-live="polite"` on all toast containers
- **DB Indexes** — 9 indexes covering all filter/sort columns
- **Kanban Group-By Persistence** — localStorage for group selection
- **Shared API Helpers** — `apiError()` / `apiJson()` in `lib/api-response.ts`
- **ADRs 0008-0011** — Phase 27-30 architectural decisions
- **AppArmor Profile** — restrictive `apparmor.txt` for HA add-on container security
- **HA Ingress User Identity** — extract `X-Hass-User-Id` and `X-Hass-Is-Admin` from Supervisor headers
- **Auth API** — `auth_api: true` enables Supervisor auth backend validation
- **Panel Admin** — sidebar panel restricted to HA admin users
- **Non-root Container** — Dockerfile runs as `meitheal` user instead of root
- **Dynamic CSP** — `frame-ancestors` adjusts for HA ingress iframe embedding
- **Translations** — English option descriptions in `translations/en.yaml`
- **tmpfs** — `/tmp` mounted as tmpfs for ephemeral storage
- **Activity Log UI** — collapsible `<details>` section in task detail panel, lazy-loaded on expand
- **Duplicate Task Button** — 📋 button in task detail action sidebar (POST + auto-open clone)
- **Time Tracked Input** — editable minutes-tracked field in Date & Time section
- **Danger Zone** — settings page section for purge all tasks (triple-confirm) and reset settings
- **Command Palette Nav** — Go to Dashboard/Kanban/Table/Settings + Export CSV commands
- **Command Search Filtering** — typing in command palette filters both commands and tasks
- **Version Bump** — `0.3.0` Phase 32: Deep Audit

### Fixed

- Comments POST now wrapped in try/catch
- Labels GET/POST now wrapped in try/catch
- Lanes PUT/DELETE now wrapped in try/catch
- Table bulk operations wrapped in try/catch with error toasts
- Table +New Task button wired to API POST
- Inline-select sends priority as number (was string, silently ignored)

### Changed

- CSP tightened: `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`
- Settings API: key regex validation, 10KB value cap
- Import: 100KB payload guard, expanded allowlist
- Build time improved: 2.35s (from 2.49s)
- Bundle stable: tasks 10.59kB, Layout 21.91kB (gzip)
