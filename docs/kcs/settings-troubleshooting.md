---
type: "Runbook"
title: "Settings Shell Troubleshooting"
description: "Find settings and diagnose navigation problems."
---

# Settings Shell Troubleshooting

## Find and open settings

The desktop directory and the **Sections** button on narrow screens open the same ten sections. The selected section appears beside the directory or below the header. Section links keep their hash when bookmarked or opened within Home Assistant. Browser Back and Forward return to previously opened sections. Older bookmarks for **Personal** (`#personal-settings`) open **Look & Feel**, and bookmarks for **General** (`#general-settings`) open **Navigation & Shortcuts**. Open **Language & Time** for language, timezone, date format and week start.

Use **Search settings** or press `/` outside an input to open the Settings scope in the shared search. Use the arrow keys and Enter to open a result. A field result takes keyboard focus and opens any integration panel that contains it. Press Escape to close search or the section directory.

On a long Settings page, use **Scroll to top** to return to the header and keep the selected section.

### Open integration settings with the keyboard

In **Settings → Connected Services**, Tab to an integration and press Enter or Space to open its settings. Tab then reaches the separate help button and the open panel's controls. Collapsed controls stay out of the tab order. Saved settings can open their panel automatically on load. If an integration appears configured but its settings are unavailable, reload and check whether the card button reports the expanded state.

Save notifications use the selected theme's text and card colors. A colored edge distinguishes the result, and the message stays readable from the moment it appears.

## Configure the sidebar

Open the keyboard menu at the foot of the sidebar or mobile drawer and choose **Edit menu**. Focus moves to the first move handle. Drag a handle to move a destination within or between sections, including **Boards** with its Household, Areas and Projects. Focus a handle and press **↑** or **↓**. On a touch screen the handles grow to 44px. Choose **Leave edit mode** or press **Escape** to finish; focus returns to the control that opened the editor. The order is saved in this browser. Task views pinned before this editor appear as sidebar items the first time the page loads. Saving or resetting **Sidebar Configuration** in Settings returns this browser to the saved configuration.

In **Settings → Navigation & Shortcuts → Sidebar Configuration**, the **Areas** visibility and label controls apply to the Household group tree. Positioning **Boards** in the configured order places the Household tree immediately after it. Reordering preserves the labels and custom links you are editing. Each group retains its project collapse control.

Choose **Save Sidebar Config** to save and reload the current Settings section with the updated sidebar. **Reset to Default** restores the default items and ordering after confirmation. Use **New task types** in the same section to choose which creation shortcuts appear under **New task**. Pin a type there or in the New task menu to open its form in one click. Use the chevron beside **Tasks** to open or pin Calendar, Kanban, Timeline (Gantt), and Table. Pins are stored on this browser. On short phone screens, scroll the drawer to reach task views below the pinned types. The Close button stays in the header. Tabbing out closes either menu and preserves the applied filters. A pinned view carries the current filters when opened from Tasks. Opening it from another page drops the previous Tasks filters. The destination can still restore the browser’s remembered Area.

A Shopping sidebar link with a task filter opens Kanban by default. A link that names Calendar, Table, or Timeline opens that view with the Shopping filter. The plain **Tasks** link remembers the last view. Docked task Details keeps the active navigation on the screen underneath it.

In the compact sidebar, open either menu from the chevron below its icon. With top navigation enabled, the Tasks toolbar shows creation shortcuts beside **New Task**. Other pages show the same shortcuts in the top navigation. Scroll the shortcut group horizontally if there is little space. On mobile, both menus are in the navigation drawer.

The small status dot beside **Settings** reports app and storage health. Hover or use a screen reader to read its status. Home Assistant connectivity is shown separately in **Settings → Connected Services → Home Assistant**.

## Give Boards and other features personal names

Open **Settings → Navigation & Shortcuts → Labels** through Home Assistant. For example, enter **Workspace** and **Workspaces** for Board, then choose **Save labels**. The sidebar, Boards page and new Board action use your chosen forms. Search finds the page by either name. Existing links and the names of individual Boards, Groups, Projects and Tasks keep working.

Each Home Assistant account can save different names for English and Gaeilge. A blank input uses the default for that form. Choose **Use default** for one term or **Use all defaults** for the visible terms, then save. A disabled feature's label is available again when the feature returns.

If a save fails, keep the page open and try again. If another window saved first, review the current values displayed alongside your edits before saving again. Reopen Meitheal when changing Home Assistant accounts. Use Home Assistant backups for databases containing personal labels. The Settings configuration export contains installation settings.

## Choose who can use organization features

A verified Home Assistant administrator can open **Settings → Tasks & Boards → Organization features** and choose an audience for **Boards organizer**, **Groups**, **Projects**, **Planning**, **Goals**, **Routines**, **Pillars**, **Principles**, **Achievements**, or **Home Assistant Area**. Select the feature, choose **Everyone**, **Selected people**, or **Nobody**, then choose **Save availability**. An empty Selected people list saves as Nobody. Reopen the work page to see the change. Principles also require Pillars to be available.

After an audience is explicitly saved for Routines or Achievements, its corresponding legacy **Habit Tracker** or **Gamification** switch reports an HTTP 409 conflict. A Settings import containing that legacy switch also reports a conflict. Use **Organization features** to change the audience.

Before an audience is set, saving either legacy switch takes effect on the next request.

The Boards organizer contains Groups and Projects. The previous `/planning#spaces` bookmark opens Boards when Planning is available to you. Personal display labels are configured under **Navigation & Shortcuts → Labels**. Existing tasks remain reachable through their Boards with the permissions you have there.

Feature audiences also apply to direct API and page links. Governed feature reads require a connection. Activating the service worker update removes older feature responses from its caches.

## Use the Home Assistant Area task field

To offer the location field, select **Home Assistant Area** in **Organization features**, choose its audience and save availability.

Use the location picker while capturing a task or under **Metadata** in its details. A Board or Group organizes the work. **Home Assistant Area** records its physical location. Choose **None** and save to clear a location. When the registry is unavailable, other task inputs are still usable. A deleted area appears as **Saved location unavailable** and can be replaced or cleared.

## Check Home Assistant

Open **Settings → Connected Services → Home Assistant** and choose **Test Connection** to check the App’s live Supervisor connection. A standalone instance reports **Standalone**. Its Advanced form still saves standalone settings separately.

- **Access denied** means Home Assistant rejected the App’s credentials. Check its Core API access and retry.
- **Disconnected** means there is no live connection. Check the Meitheal App logs in Home Assistant and retry.
- **Check failed** means Meitheal could not read the connection state. Retry to get the latest state.

## Administrator access

Manage integration credentials, outbound integration tests, Node-RED deployment, custom CSS and factory reset through a verified Home Assistant administrator session. For standalone development, open the app on the machine running it using the loopback address. A Meitheal HTTP 403 can indicate either a regular user session or an installed Supervisor without the required trusted identity headers. Settings stays open so you can read the error and keep any work in progress. An expired Supervisor ingress session may reload to recover its connection.

Settings downloads exclude credential values. Settings imports also skip credential fields in older files. After an import, re-enter integration secrets separately in Settings. A masked value in Settings means the existing value is kept if the mask is submitted unchanged.

Save CalDAV or Grocy credentials and run Calendar, To-do, and Grocy sync from Settings with the current Board session. If sync needs an approved destination, open the Board’s integration settings to approve the source and choose where its work belongs.

An imported theme keeps its saved mode when Meitheal recognizes it. An empty or unrecognized theme in the backup restores Emerald Isle while the rest of the settings import proceeds.

## Recover from an error

- If Settings cannot load, choose **Try again**. The controls are paused until Meitheal can read the stored values.
- If a theme or regional preference fails to save, its control returns to the last known value. Check the connection or your permissions and try the change again.
- If a save reports that some changes were saved, its form keeps your entries. Retry the save to finish, or reload Settings to see the stored values. For Calendar and To-do, the save also checks whether the sync service accepted the request.
- The accent picker is a browser preference. Use **Reset** in **Look & Feel** to restore the default accent.

### A household member is missing

**People & Notifications** uses the same user list for **Users & Assignment** and notification overrides. Adding or removing a custom user refreshes both lists. If Home Assistant users could not load, custom users and their preferences are still available when the local database responds. Check the Home Assistant connection under **Connected Services**, then reopen Settings.

### Reopen Settings in Home Assistant Companion

1. Go to `Settings → App & Companion`.
2. Use `Open in Companion` for the documented `homeassistant://navigate/...` flow.
3. Use `Copy x-callback URL` when wiring Siri Shortcuts or automation callbacks.

These actions preserve the ingress-safe route and reopen the exact Settings section.

### Webhooks sends me to the wrong place

The Webhooks callout in **Connected Services** opens **AI & Agent Access**. If it does not:

1. Refresh the page once.
2. Re-open `Settings → Connected Services`.
3. Select the **AI & Agent Access** link in the Webhooks callout again.

If the URL does not change to `#ai-agents-settings`, capture the browser console and file a bug.

### Theme changes do not seem to persist

1. Go to **Settings → Look & Feel → Theme & Accent**.
2. Change the theme once and wait for the UI to update.
3. Re-open Settings.

Select **Light**, **Emerald Isle**, or **Knight Rider** to keep that Meitheal palette. **Auto** follows the appearance of a same-origin Home Assistant panel as it changes. A direct ingress page and a panel whose appearance cannot be read follow the device preference. A browser with an unrecognized cached theme uses **Auto** until a supported theme is selected.

Turn on **Match Home Assistant theme** to use the colors Home Assistant has set when you open Meitheal from its Home Assistant sidebar entry. The checkbox is off by default and saves in the current browser. The **Theme** selector still sets the fallback. You can turn matching off any time to return to that theme, including your saved accent and custom theme.

Meitheal follows Home Assistant's background, text, primary action and accent colors. It uses a readable color for text and focus when a theme color has too little contrast. The status under the checkbox explains when Meitheal is using the selected theme instead. This can happen in the direct web app, in the installed PWA, with unreadable theme colors, or with the browser's forced-colors or higher-contrast preference. The Home Assistant Webpage dashboard card does not establish an App ingress session. Open Meitheal through the Home Assistant sidebar to start an authenticated session and use matching.

In an administrator session, choose **Custom** to import a CSS file up to 50 KB. The imported palette becomes active after the file, filename and theme mode save together. Select the displayed filename to download the saved CSS. Light, Emerald Isle, Knight Rider and Auto update the installation's saved mode and keep the file available for later use. Choose **Remove custom theme** to clear the file and switch to Emerald Isle. A regular Home Assistant member gets the built-in modes. After an account change, a live navigation applies the current session's theme permissions.

In **Look & Feel**, **Emerald Isle** is the name of the existing green dark theme. **Knight Rider** uses charcoal surfaces and blue controls. Active tasks use a rose fill by default in Today, Dashboard and Board task views. A saved status change in Details updates the active treatment on the calling view. In Knight Rider, a saved task color tints the whole task surface and keeps the rose edge on active work. Set it with **Set card color** on the Board or the swatch beside Labels in **Details → Metadata**. Knight Rider starts with the compact sidebar when this browser has no saved choice. **Completed today** previews up to 20 Complete Household Board tasks last updated on the household day. **Archive completed** includes all eligible Household Board tasks, even beyond the 20 shown. Archived tasks stay in storage and are removed from the Dashboard’s task lists and counts. Tickets on named Boards stay there. Choose **Refresh Today** if the date changed since you opened the page.

Within the same Today visit, a saved status change from Work or task Details updates the row and its Focus Stack card. Today retains keyboard focus if you Tab to another visible control while the save runs. Reopening restores the card if it was already in that stack. Completing an overdue task removes it from the **Overdue** filter. Reopening restores the overdue label when the deadline has passed.

An accent chosen in **Look & Feel** stays in this browser. The keyboard focus color follows a readable version of the accent and keeps at least 3:1 contrast with the page, even when the accent matches the page background. Use **Reset** beside the color swatches to return to the palette's default accent. Filled primary buttons choose readable dark or light text for a custom accent, including its hover state. Native date and select controls follow the same effective Light or Dark mode as the app. Form hints stay readable when the input receives focus.

- Open **Look & Feel** to choose the theme, accent, typeface, neutral palette, corner roundness, content width, page headers, and panel style. Choices preview live; select **Save appearance** to apply them. The theme is a server-wide setting, so a saved theme change applies to everyone using this installation. The other appearance choices and the accent save in this browser only. A save captures the choices shown when you select **Save appearance**. If you reset or edit while the save is pending, those changes stay in preview until you save again.

- **Look & Feel** also holds the navigation layout, navigation color, navigation edges, and sidebar behavior. The action bar appears during a preview with **Save appearance** and **Discard**. When appearance overrides are present, **Reset to defaults** under **Theme & Accent** previews the original layout, accent, and Home Assistant matching while keeping the selected theme. Save to apply the reset.

Top navigation replaces the desktop sidebar with horizontal destination lists and one **More** disclosure for destinations that do not fit. Crowded Tasks view links use the same disclosure. The current destination stays visible when it fits. The links retain their URLs, so opening them in a new tab and Home Assistant ingress navigation continue to work. Use arrow keys or Home/End to move through the open disclosure; Escape closes it and returns focus to More. Resizing keeps the focused link reachable, including opening More if that link moves into it. The Areas disclosure opens its existing hierarchy; Escape closes it and returns focus to its summary. Phones retain their mobile navigation in either layout. Pinned Task shortcuts return when a desktop Top navigation layout switches to the mobile drawer. Floating navigation adds inset edges; floating panels affect task detail, search and the day drawer. **Fluid** removes the Settings reading-width limit; **Boxed** centers content within a reading width.

Sidebar behavior applies to desktop sidebar navigation. **Remember last state** uses the existing collapse toggle preference. **Start expanded** and **Start folded** set the state each time a page opens; the toggle remains available. **Expand on hover or focus** temporarily opens the rail for pointer or keyboard navigation without moving the page content. Closing it with the edge arrow or **Ctrl+B** keeps it folded while you remain inside the compact rail. Leave and return to open it again. These choices do not change per-Area or whole-Areas-group disclosures.

If an appearance save reports a browser storage error, the current appearance and your edited choices stay intact. Retry after allowing site storage. Invalid or old stored choice values use defaults; valid saved and unrelated fields are retained when saving. Appearance preferences are local under `meitheal-appearance`; the remembered sidebar state stays under `meitheal_sidebar_collapsed`. They do not add or rename `/api/settings` fields.

If the theme still resets:

- Select **Save appearance** before you leave or reopen Settings. Unsaved choices are only a preview.
- Check that `/api/settings` writes are not failing in the browser network panel.
- Check whether local storage is being cleared by privacy tooling.

### The language did not change

Choose English or Gaeilge under **Settings → Language & Time → Display Language**. Meitheal reloads the page and sends the dictionary for that language. If the interface still uses the previous language after reload, check whether your browser is accepting the `meitheal-locale` cookie.

### App & Companion shows `HTTP only`

This means the current origin is not a secure context. Service workers and install prompts require HTTPS or localhost.

Recommended paths:

- Nabu Casa
- DuckDNS + Let's Encrypt
- Reverse proxy with TLS

### Check browser and installed app notifications

Open **Settings → App & Companion → Troubleshooting** and choose **Send a test notification**. Allow notifications if prompted. Check this device’s notification center and open the test notification to return to **App & Companion**.

If permission is blocked, allow notifications in the browser’s site settings and try again. If the test cannot send, reload the HTTPS app to give its service worker time to start. Home Assistant Companion alert recipients are configured under **Settings → People & Notifications → Notifications**.

### Delete old completed tasks

1. Go to **Settings → Backups & Reset**.
2. In the **Archiving & Data Retention** card, select a period (3, 6, 12, or 24 months).
3. Click **Preview** to see how many tasks would be deleted.
4. Click **Delete Tasks** and confirm in the dialog.

The deletion cascades to comments, activity logs, and task links. An audit trail entry is created.

Export your data first under **Backups & Reset → Data Portability → Export Tasks**.

### Preview shows 0 tasks but I have old completed tasks

This feature uses the `updated_at` timestamp. If a completed task was edited recently (e.g. notes added), its `updated_at` resets and it won't match the age filter. This is by design — it protects recently-touched data.

### What's the difference between Archive and Delete?

- **Archive**: Hides a completed task from default views. Data is preserved. Reversible.
- **Delete**: Permanently removes the task and all related data. Irreversible.

See `docs/kcs/task-lifecycle-glossary.md` for the full ubiquitous language reference.

## HEART Acceptance Lens

- Happiness. Status and save feedback appear beside the controls and after each action.
- Engagement. All sections are reachable from the desktop directory or the narrow-screen Sections button.
- Adoption. Companion and PWA actions should be discoverable in **App & Companion**.
- Retention. theme and settings state should survive reloads and hash deep-links.
- Task success. all cross-links should land on real section ids.

## Home Assistant conversation agents

Settings → AI & Agent Access and Ask Home Assistant require a currently verified
Home Assistant administrator. They discover agents from Home
Assistant's `conversation/agent/list` WebSocket command. HA includes loaded
`conversation.*` entities and agents registered through integration config
entries in this response. No provider list or language filter is applied. A
configured integration without a loaded conversation agent is not runnable and
will not appear until Home Assistant loads it.

Both pickers refresh when opened and offer **Refresh agents**. Returning to
**AI & Agent Access** refreshes discovery and keeps the selected agent. Settings controls
become available after saved preferences load, even if initial agent discovery
has already finished. Once the refresh button has keyboard focus, it keeps focus
during discovery and ignores repeat activation. Refresh and discovery status use
the selected language. Proxy failures with HTML or empty responses show a stable
discovery error instead of a JSON parser exception. Discovery bypasses
browser caching. A saved agent ID stays selected if the agent is removed or HA
cannot be reached; it is never silently replaced by the default. An unavailable
agent is labelled in the picker. Ask Home Assistant prevents sending to an agent
confirmed missing by a successful discovery. Select an available agent, or fix
its integration in HA and refresh. A failed discovery displays a retry message
while preserving the last selection. This failure is separate from the app's
own connection to its server. The compact app status beside Settings remains reachable through its accessible description. Operator logs distinguish static `invalid_agent_payload` and `websocket_request_failed` reasons without recording the HA payload.

Ask Home Assistant keeps its chat and HA conversation ID when closed and
reopened on the same page. The first reply can continue while the page finishes
loading. Changing the selected agent starts a new conversation.
The Settings default is persistent; the most recent Ask selection is stored for
the browser session. Saving a new Settings default clears that session override.

For native qualification, open the managed Canary through HA ingress, confirm
all loaded agents match HA's Assist picker, add or reload an agent in HA, and
refresh both Meitheal pickers. Test a multi-turn exchange, close/reopen, then
change agents. An isolated browser fixture checks the picker behavior but does
not establish Supervisor permissions or HA integration health.

Upstream contract: [HA conversation WebSocket implementation](https://github.com/home-assistant/core/blob/master/homeassistant/components/conversation/http.py)
and [registered-agent manager](https://github.com/home-assistant/core/blob/master/homeassistant/components/conversation/agent_manager.py).

## Verify a Settings change

For rejected rule saves, framework overrides or Settings imports, see [Recovering rules and framework settings](settings-configuration-recovery.md). Validation and write failures preserve the previous configuration; resolve the reported input or storage error before retrying.

Run the Astro dev server against a disposable database. Run the Settings, Theme and Search Hub browser specs with `E2E_BASE_URL` pointed to that server. Check compact viewports, both palettes and keyboard focus with integration cards open and closed.

The Auto/HA contrast cases in `task-theme-contrast.spec.ts` load the real theme bridge through Vite in a synthetic same-origin frontend frame. Run that spec against the Astro dev server; a production server does not expose `/src` modules. The frame checks frontend theme selection, not Supervisor authentication. Keep separate production coverage for Dark/Light controls, saved accents, tags and the Dashboard. Run production browser specs with a fresh fixture per spec, as `test:ci` does, so their shared request volume does not exhaust the unchanged rate limit. Settings' Agent handoff card describes the current administrator review flow and links to Review.

Use the Home Assistant devcontainer to check the ingress page, Companion URL construction in that scope and Calendar or To-do service changes. Use test entities. A loopback ingress proxy is useful for checking URL construction and browser requests. Supervisor behavior and mobile app handoff require their own checks.

## Navigation and daily review

Ticket links retain the background view when changing board pages or using keyboard view shortcuts. Closing a legacy ticket link returns to its source page. Direct ticket URLs select Tasks in the mobile tab bar. On local HTTP, drawer and custom-link IDs use the browser's available cryptographic random source. Project deletion keeps the Home Assistant ingress path.

Today formats its visible and machine-readable dates in the workspace timezone, using the selected language. Evening dismissal and snoozing use the browser's local calendar date; blocked browser storage does not stop the review controls.

## Home Assistant connection changes

The App uses the Supervisor connection when available. Standalone installations use a complete saved URL/token pair, then an environment pair. Saving changed credentials replaces the authenticated WebSocket and entity subscription; incomplete saved pairs do not mix credentials with environment settings. Connection status never includes tokens. If setup began before Home Assistant was configured, retry after saving the pair.

Integration changes require a current Settings session and management access to each Board served by the integration. If Settings rejects a save after access changes, reopen Settings and review the integration’s Board destinations before retrying.

Calendar sync distinguishes an empty successful response from a missing or failed response. A partial or skipped manual sync reports failure with per-calendar outcomes, so existing tasks are not presented as a successful empty import. Use a disposable calendar to check empty success, disconnected failure and partial failure after changing connection settings. Assist uses the current selected agent; an explicit empty selection uses built-in Assist.

Credential changes during initial authentication retire the pending attempt; it cannot publish an old connection after a newer configuration takes over. Removing or rejecting credentials clears the previous entity snapshot immediately. Registered application listeners remain available for the next successful connection. A populated-cache rotation check covers these cases separately from the ordinary empty-snapshot connection check.

If Home Assistant’s user list cannot load, People & Notifications keeps the saved default assignee selected as **Current assignee (unavailable)**. Use **None (unassigned)** when you want to clear it.
