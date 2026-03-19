# DDD Audit: Per-Domain Persona Panel Reviews

**Project:** Meitheal — Task Management & Strategic Planning Hub
**Audited:** 2026-03-19
**Methodology:** ADHD Panel, Frontier Panel, Accessibility Panel, DDD Boundary Panel per domain

---

## SA-1: Core Task Views

**Domains:** Tasks (persistence + package), TaskListItem, TaskDetailModal, NewTaskModal
**Pages:** Dashboard `/`, Today `/today`, Kanban `/kanban`, Table `/table`, Upcoming `/upcoming`, Review `/review`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Clarity of primary action | 8/10 | Quick-add in Today is well-positioned; Kanban add-card is discoverable |
| Overwhelm prevention | 6/10 | Dashboard shows stats + recent + favorites + open tasks — could feel busy. Today's 8-section layout risks cognitive overload |
| Focus facilitation | 7/10 | Today page "Pinned/MITs" section is excellent for ADHD. Carried-forward triage is good |
| Task entry friction | 8/10 | NL-aware quick-add with `#tags`, `today`, priority shortcuts is excellent |
| Visual chunking | 7/10 | TaskListItem has clear visual hierarchy (checkbox → title → meta). Kanban columns provide natural grouping |
| Completion dopamine | 9/10 | Confetti animation, XP notifications, streak tracking — strong completion reward loop |

**Recommendations:**
- **Dashboard**: Add a "Focus Mode" that hides everything except today's MITs (3 tasks max)
- **Today page**: Consider collapsible sections with remembering open/closed state — 8 sections is too many to scan for ADHD users
- **Quick-add**: Add keyboard shortcut indicator (currently `Q` but not visually indicated on button)
- **Kanban**: The completed task auto-hide (30-day retention) is good — consider a "just today" option for ADHD users who want clean boards

### Frontier Panel (Release Readiness)

| Area | Status | Gaps |
| --- | --- | --- |
| Task CRUD | ✅ Release-ready | Full lifecycle: create, read, update, delete, duplicate, reorder |
| Kanban | ✅ Release-ready | Drag-drop, WIP limits, column customization, card customizer |
| Table view | ✅ Release-ready | Column customizer, subtask hierarchy, saved filter presets |
| Today view | ✅ Release-ready | 8 sections, smart suggestions, MITs, carried-forward triage |
| Upcoming view | ⚠️ Near-ready | 7-day look-ahead works; needs ability to quickly reschedule from this view |
| Gantt view | ⚠️ MVP-level | Static 5-week grid, no drag-to-resize, no dependency editing, no zoom |
| Review queue | ⚠️ Niche | Bot proposal review — only relevant for AI agent users. Functional but sparse |
| Task detail modal | ✅ Release-ready | Rich: title, description (MD), checklists, attachments, activity, comments, links, time tracking, custom fields |
| Bulk operations | ❌ Missing | No multi-select + bulk status/priority/label change |
| Keyboard navigation | ⚠️ Partial | J/K nav exists on Kanban; incomplete across views |

### Accessibility Panel

- TaskListItem: Good `role="button"`, `tabindex="0"`, descriptive `aria-label` with priority and due date
- Checkbox has `aria-label={Complete ${task.title}}`
- Favorite button has toggle `aria-label`
- **Gap:** Kanban drag-drop likely needs ARIA live regions for screen readers
- **Gap:** Table sort/filter changes need announcements
- **Gap:** Color-only status indicators (priority dot colors) need text/icon alternatives

### DDD Boundary Health

- **Clean:** `TaskRepository` is the single persistence gateway. All pages go through `getTasksForView()` or repository methods
- **Clean:** `TaskListItem` is the single source of truth for list rendering (documented in JSDoc)
- **Concern:** `task-queries.ts` in `lib/` is an application-layer query builder that imports from `@domains/tasks/persistence/` — this is acceptable as an anti-corruption layer but could be pushed into the domain
- **Concern:** 7 repository classes in `persistence/` (task, board, lane, user, settings, template, hierarchy) — `HierarchyRepository` handles goals/areas/projects which are arguably a separate bounded context

---

## SA-2: Hierarchy & Projects

**Domains:** Tasks (hierarchy repos: HierarchyRepository)
**Pages:** Projects `/projects`, Project Detail `/projects/[id]`
**API:** `/api/projects/*`, `/api/goals/*`, `/api/areas/*`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Organizational clarity | 7/10 | Area → Goal → Project → Task hierarchy is logical but may feel like forced structure |
| Navigation simplicity | 6/10 | Sidebar hierarchy tree is collapsible but could overwhelm with many items |
| Progress visibility | 8/10 | Project cards show completion count/total with visual progress bars |
| Entry friction | 5/10 | Creating Areas → Goals → Projects requires multi-step thinking — ADHD friction |

**Recommendations:**
- Add "Quick Project" creation that auto-creates goal/area if none exist
- Show project status as emoji/color band, not just text
- Add drag-to-reorder projects on the grid view
- Consider a "flat view" option that shows all tasks across projects

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Project grid | ⚠️ Near-ready | Shows cards with progress, goal breadcrumbs, icons |
| Project detail | ⚠️ Near-ready | Task list within project — needs more project-level metadata display |
| Goal management | ⚠️ Basic | CRUD API exists; no dedicated goal dashboard page |
| Area management | ⚠️ Basic | CRUD API exists; lives only in settings/API, no visual presence |
| Hierarchy tree sidebar | ✅ Release-ready | Collapsible tree in sidebar, feature-flagged |

### DDD Boundary Concern

- Areas, Goals, and Projects are handled by `HierarchyRepository` alongside tasks — this should arguably be a separate bounded context (`domain-hierarchy` or `domain-projects`)
- The `HierarchyRepository` lives in `domains/tasks/persistence/` which couples hierarchy to task persistence

---

## SA-3: Calendar & Time

**Domains:** Calendar, Pomodoro
**Pages:** Calendar `/calendar`, PomodoroTimer (global widget)
**API:** `/api/integrations/calendar/*`, `/api/pomodoro`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Time visualization | 7/10 | Monthly calendar with task count dots per day; HA event overlay |
| Quick time entry | 6/10 | Click-to-day works but adding tasks from calendar is not obvious |
| Timer simplicity | 8/10 | Pomodoro timer is floating, minimal — start/stop/complete. Very clean |
| Break reminders | 7/10 | Auto-transitions between focus/break phases. No audio/vibration cue though |

**Recommendations:**
- Calendar: Add "click day to add task with that due date" (pre-fill date picker)
- Calendar: Show task titles on hover-over day cells, not just counts
- Pomodoro: Add optional sound/vibration when timer ends (critical for ADHD!)
- Pomodoro: Show "what are you working on?" with task selector before starting

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Monthly calendar | ⚠️ Near-ready | Works with task counts, HA event counts, week-start config. Needs day-click→task creation |
| Week/day view | ❌ Missing | Only monthly grid — no weekly or daily timeline view |
| CalDAV sync | ⚠️ Functional | `caldav-client.ts` exists but isn't wired to settings UI |
| HA calendar sync | ✅ Release-ready | Full bidirectional sync with deduplication, multi-entity support |
| Pomodoro timer | ✅ Release-ready | Focus/break/long-break cycle, task association, session history |
| Time tracking | ⚠️ Basic | Time entries exist via Pomodoro; no standalone time tracking UI |

---

## SA-4: Gamification & Habits

**Domains:** Gamification, Habits
**Pages:** Gamification `/gamification`, Habits `/habits`
**API:** `/api/gamification`, `/api/habits`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Motivation mechanics | 8/10 | XP on task completion, level system, streaks — textbook ADHD dopamine optimization |
| Visual reward | 9/10 | Progress ring, confetti, fire emoji streaks, achievement gallery — deeply satisfying |
| Overwhelm risk | 5/10 | Gamification page shows ALL data at once: level, stats, achievements, weekly chart, yearly heatmap |
| Habit simplicity | 7/10 | Simple name + icon + frequency form. Daily completion is one tap |
| Streak anxiety | 4/10 | Losing a streak can be demotivating for ADHD. No "freeze" or "grace period" mechanic |

**Recommendations:**
- **Critical:** Add streak freeze/grace days (1-2 missed days don't break streak) — streak anxiety is a known ADHD pitfall
- Gamification page: Use tabs or progressive disclosure instead of showing everything at once
- Daily goal: Make the target configurable from the widget (currently 5, hard-coded in component prop default)
- Achievements: Add toast notification when an achievement unlocks (not just gallery view)
- Habits: Add "suggested habits" starter templates (exercise, hydration, medication, journaling)

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| XP / level system | ✅ Release-ready | Priority-weighted XP, level calculation, progress-to-next |
| Achievement engine | ✅ Release-ready | Locked/unlocked gallery, predefined achievements |
| Streak tracking | ⚠️ Near-ready | Needs streak freeze mechanic for release |
| Weekly chart | ✅ Release-ready | Bar chart with completion counts |
| Activity heatmap | ✅ Release-ready | GitHub-style yearly contribution grid |
| Habit CRUD | ✅ Functional | Create, edit, delete, complete habits |
| Habit streaks | ⚠️ Basic | Per-habit streaks calculated from completion dates |
| Habit integration | ✅ Release-ready | Habits create real tasks (is_routine=1) visible across views |

### DDD Boundary Health

- **Clean:** Gamification has a proper barrel file (`index.ts`) as public API
- **Concern:** `habit-service.ts` imports directly from `domains/tasks/persistence/store` — tight coupling to task persistence. Habits are conceptually a separate aggregate

---

## SA-5: Strategy & Labels

**Domains:** Strategy (package + app), Labels
**UI:** StrategicEvaluator modal, Settings > Rules, Label pickers, filter bars, badges
**API:** `/api/rules/*`, `/api/frameworks/*`, `/api/labels/*`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Decision support | 7/10 | RICE scoring reduces decision paralysis — excellent for ADHD |
| Complexity | 4/10 | Framework wizard, custom rules, rule resolution — may overwhelm non-power users |
| Label discoverability | 8/10 | LabelPicker with autocomplete, LabelBadges with colors — visually clear |
| Filter persistence | 8/10 | Saved filter presets — excellent for ADHD users who need consistent views |

**Recommendations:**
- Strategy: Add "Smart Suggest" that auto-evaluates RICE based on task metadata (don't require manual scoring)
- Strategy: Default to a single framework (RICE) with optional advanced mode for custom frameworks
- Labels: Add label groups/categories for organization when label count grows
- Saved filters: Show top 3-5 saved filters as quick-access chips above filter toolbar

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| RICE scoring | ✅ Release-ready | Full Reach/Impact/Confidence/Effort calculation |
| Custom frameworks | ✅ Release-ready | Create, edit, export frameworks with custom weights |
| Rule resolver | ✅ Release-ready | Priority/status rules with defaults |
| Framework wizard | ⚠️ Complex | Full wizard in settings — may need onboarding guidance |
| Label CRUD | ✅ Release-ready | Create, delete, color pickers |
| Label color resolver | ✅ Release-ready | Fallback colors, hex validation |
| Framework badge | ✅ Release-ready | Score display on task cards |

---

## SA-6: HA Integration

**Domains:** HA, Todo, Notifications
**UI:** Settings > HA, AskAssist modal, background sync
**API:** `/api/ha/*`, `/api/todo/*`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Setup complexity | 6/10 | HA connection auto-detects via ingress token — zero config when inside HA |
| Sync status visibility | 5/10 | Sync status is in settings only; no persistent indicator in main UI |
| Error recovery | 4/10 | WebSocket reconnection is automatic but error state isn't surfaced to user |
| Assistant integration | 7/10 | "Ask AI" button in task detail + AskAssist modal — natural interaction point |

**Recommendations:**
- Add a subtle HA connection status indicator in the sidebar footer (green dot = connected)
- Surface sync errors as non-blocking toasts rather than silent failures
- Todo sync: Show last-sync time in sidebar or footer
- Consider auto-opening Ask Assist when a user types `?` or `/` in quick-add (natural command trigger for ADHD)

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| HA WebSocket | ✅ Release-ready | Auto-reconnect, connection singleton, supervisor auth |
| Entity subscription | ✅ Release-ready | Real-time state changes via WS |
| HA services | ✅ Release-ready | Call any HA service domain |
| HA users | ✅ Release-ready | User resolution from HA |
| Todo sync | ✅ Release-ready | Bidirectional, subscription-based, status mapping |
| Notifications | ✅ Release-ready | Due-date reminders, HA calendar event creation |
| HA Assist (AI) | ✅ Release-ready | Conversation.process, agent selection |
| Connection error UI | ⚠️ Basic | Only in settings; no main-UI indicator |

### DDD Boundary Health

- **Clean:** HA domain has proper barrel file with controlled exports
- **Clean:** Todo bridge uses mapper pattern for status translation
- **Concern:** Notifications domain has cached module references to HA domain internals — lazy-loaded but still a cross-context deep import

---

## SA-7: External Integrations

**Domains:** Grocy, Calendar Sync, Vikunja Compat, N8n/NodeRED
**UI:** Settings > Integrations subsections
**API:** `/api/grocy/*`, `/api/integrations/*`, `/api/v1/*`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Setup linearity | 7/10 | The SettingsCallout "Recommended setup order" is excellent guidance |
| Configuration clarity | 6/10 | Each integration is a collapsible card — good. But within each, many options |
| Sync status feedback | 5/10 | Sync status available but not prominently displayed |
| Error messages | 6/10 | Structured error handling but messages could be more actionable |

**Recommendations:**
- Add visual "sync pulse" animation on active integrations
- Grocy: Auto-detect Grocy addon via HA supervisor API (reduce manual URL entry)
- Calendar: Show a preview of discovered calendar entities before enabling sync
- Webhooks: Add "test webhook" button with visual success/failure indicator

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Grocy sync | ✅ Release-ready | Bidirectional chore/task/shopping sync, auto-key discovery |
| Calendar sync | ✅ Release-ready | Multi-entity, bidirectional, deduplication |
| CalDAV | ⚠️ Partial | Client exists but UI for external CalDAV servers (non-HA) is not wired |
| Vikunja compat | ✅ Release-ready | Full v1 API compatibility layer |
| N8n integration | ⚠️ Basic | Health check, workflow listing. No deep workflow management |
| NodeRED integration | ⚠️ Basic | Status, deploy, flow listing |
| Webhooks | ✅ Release-ready | Configurable outbound webhooks |
| Integration test | ✅ Release-ready | Test event/webhook buttons in settings |

---

## SA-8: Search & AI

**Domains:** Search, AI
**UI:** SearchHub (⌘K), AskAssist modal
**API:** `/api/search`, `/api/ha/assist`

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Search speed | 8/10 | Server-side search with snippet highlights — fast |
| Command palette feel | 9/10 | ⌘K/Ctrl+K launcher with pages, actions, settings, tasks — excellent UX pattern |
| Search scope | 7/10 | Searches tasks (with field selection), settings, pages. Could add labels |
| AI accessibility | 6/10 | "Ask AI" button exists but isn't the primary interaction — should be more prominent |

**Recommendations:**
- Add "/" commands in search (e.g., `/new`, `/focus`, `/timer`) — power-user ADHD optimization
- Show recent searches/actions when search opens (immediate context)
- AI: Add suggested prompts in AskAssist modal ("What should I work on?", "Summarize my week")
- Search should support natural language like "tasks due this week" filtering

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Universal search | ✅ Release-ready | Multi-scope: tasks, settings, pages, actions |
| Keyboard shortcut | ✅ Release-ready | ⌘K / Ctrl+K |
| Result sections | ✅ Release-ready | Grouped by type (pages, actions, tasks, settings) |
| Snippet highlights | ✅ Functional | Context snippets around matched text |
| HA Assist | ✅ Release-ready | Conversation.process, agent picker, clipboard fallback |
| NL task parsing | ✅ Release-ready | /api/parse-task for natural language |
| Command palette | ⚠️ Near-ready | Actions exist but limited set (new task, ask HA) |

---

## SA-9: Offline & PWA

**Domains:** Offline domain (8 files)
**UI:** Offline fallback page, sync indicators, PWA install banner
**API:** N/A (client-side)

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Offline awareness | 5/10 | Only a dedicated offline page — no in-context "you're offline" banner |
| Sync confidence | 4/10 | Background sync happens but user has no visibility into queue status |
| Data safety feeling | 6/10 | "Your local data is safe" messaging is good but needs more reinforcement |
| PWA install | 7/10 | Install banner exists, manifest configured |

**Recommendations:**
- **Critical for release:** Add an always-visible connectivity indicator (e.g., subtle bar at top when offline)
- Show sync queue count in UI (e.g., "3 changes pending sync")
- Add manual sync button for users who want explicit control
- Toast notification when sync completes: "All changes synced ✓"
- Conflict resolution UI — currently last-write-wins with no user notification

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Service worker | ✅ Functional | sw-register.ts handles registration |
| IndexedDB store | ✅ Functional | Full task mirror with sync metadata |
| Sync engine | ✅ Functional | FIFO queue, retry with backoff, conflict detection |
| Tab sync | ✅ Functional | BroadcastChannel for multi-tab coordination |
| Connectivity detection | ⚠️ Basic | Online/offline events but no quality-of-connection |
| Export service | ✅ Release-ready | Client-side data export |
| Sync lock | ✅ Functional | Prevents concurrent sync |
| Offline page | ⚠️ Minimal | Static retry/dashboard buttons only |
| Conflict resolution UI | ❌ Missing | Last-write-wins with no user notification |
| PWA manifest | ✅ Release-ready | Full manifest, icons, theme color |

---

## SA-10: Auth & Infrastructure

**Domains:** Auth (package + app), Observability, Middleware
**UI:** Transparent (middleware)

### ADHD Panel Review

Not directly user-facing, but impacts:
- Rate limiting (300 req/min) — generous enough for fast task entry
- CSRF protection — transparent, doesn't interrupt user flow
- Security headers — properly configured, no upgrade-insecure-requests behind ingress

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Ingress detection | ✅ Release-ready | Auto-detects HA ingress from X-Ingress-Path header |
| CSRF protection | ✅ Release-ready | Allowlist-based validation |
| Rate limiting | ✅ Release-ready | 300/min per IP, memory-capped at 10K entries |
| Bot rate limiting | ✅ Release-ready | Separate rate limit for bot/agent users |
| Security headers | ✅ Release-ready | CSP, XCTO, X-Frame-Options |
| Structured logging | ✅ Release-ready | JSON lines, Loki-compatible, redaction |
| WebAuthn | ⚠️ Mock only | Config and mock exist; no real implementation |

### DDD Boundary Health

- **Clean:** Auth domain has separate package-level and app-level concerns
- **Clean:** Ingress policy is isolated from task domain
- **Concern:** Middleware does a lot — auth, rate limiting, settings reads, HA init, CSRF, HTML rewriting. Consider splitting into composed middleware functions

---

## SA-11: Layout & Shell

**Domains:** Layout, Sidebar, Settings Shell, Shared UI
**UI:** Layout.astro, Sidebar, TopNavigation, Settings page (7 sections, 16+ components)

### ADHD Panel Review

| Criterion | Score | Notes |
| --- | --- | --- |
| Navigation discoverability | 8/10 | Sidebar with icons, labels, badges, collapsible tree — clear navigation |
| Information density | 6/10 | Sidebar shows a lot: nav items, board switcher, hierarchy tree, streak badge, footer |
| Settings findability | 7/10 | UnifiedBar with tab navigation + search scope — good pattern |
| Mobile experience | 6/10 | Responsive hamburger menu exists; sidebar sliding — needs testing |
| Theme/dark mode | 8/10 | HA theme bridge, CSS custom properties — well-architected |
| Global modals | 9/10 | TaskDetail, NewTask, StrategicEvaluator, AskAssist, Search — consistent overlay pattern |

**Recommendations:**
- Sidebar: Add a "Collapse to icons only" mode for focus (ADHD users often prefer minimal navigation)
- Settings: The 7-section layout with 16+ components is comprehensive but could benefit from a "Quick Setup" onboarding wizard
- Mobile: Ensure all modals are full-screen on mobile (not just overlays that partially show content behind)
- Add haptic feedback on mobile for completions and navigation
- Consider a "Compact Mode" setting that reduces spacing/padding globally
- Layout: The scroll-lock guard (MutationObserver) is defensive engineering — good for HA ingress iframe issues

### Frontier Panel

| Area | Status | Gaps |
| --- | --- | --- |
| Sidebar navigation | ✅ Release-ready | Configurable items, order, custom links, badges |
| Board switcher | ✅ Release-ready | Multi-board with color indicators |
| Hierarchy tree | ✅ Release-ready | Collapsible area/goal/project tree |
| Top navigation | ✅ Release-ready | Mobile-optimized compact bar |
| Settings shell | ✅ Release-ready | Tabbed sections, search, scroll-to-section |
| Theme system | ✅ Release-ready | CSS custom properties, HA theme bridge, dark mode |
| i18n | ⚠️ Partial | English + Irish (ga) only — structure supports more |
| PWA install banner | ✅ Release-ready | Prompts install on capable browsers |
| Keyboard shortcuts | ⚠️ Partial | Some exist (Q = new task, ⌘K = search) but not documented in-app |
| View transitions | ⚠️ Disabled behind ingress | ClientRouter disabled to prevent redirect loops |

### Settings Sub-Panel Detail

| Section | Component(s) | Release Status |
| --- | --- | --- |
| Personal | SettingsPersonal | ✅ Theme, locale, date format |
| Workflow | SettingsGeneral, SettingsLabels | ✅ Sidebar config, custom fields, labels |
| Rules & Lenses | SettingsRules | ✅ Framework/rule management |
| Automation & AI | SettingsAgents | ✅ Agent configuration |
| Integrations | 6 integration components | ✅ HA, Calendar, Todo, Grocy, N8n, Webhooks |
| App & PWA | SettingsAppPwa | ✅ PWA settings, export/import |
| Danger Zone | SettingsDangerZone | ✅ Data reset, backup/restore |
