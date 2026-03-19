# Unified Bar Cross-Page 50-Persona Audit

> Date: 2026-03-19
> Scope: Today, Upcoming, Calendar, Kanban, Table
> Goal: decide the strongest Home Assistant-native shell direction before implementation

## Consensus

1. Keep one mature primary shell across pages.
2. Keep route-level task-view switching as a distinct secondary layer on Calendar, Kanban, and Table.
3. Preserve page-context links instead of compressing everything into one top strip.
4. Use section anchors to reduce cognitive load and preserve ingress-safe navigation.
5. Roll out Today first, then Upcoming, Calendar, Kanban, and Table.

## ADHD And Executive Function Panel

| Persona | Verdict | Recommendation |
| --- | --- | --- |
| Maya, ADHD product designer | Accept | Keep one consistent shell across pages so the user never relearns the top surface |
| Declan, ADHD HA builder | Accept | Do not merge view switching into section tabs; route changes and page sections must feel different |
| Nadia, executive with ADHD | Accept | Today needs a clear triage path before dense lists begin |
| Sean, neurodivergent QA lead | Accept | Upcoming should split next-48-hours from the rest of the week |
| Tamara, ADHD freelancer | Accept | Keep shell actions short and stable; no more than two page-specific action buttons beside search and Assist |
| Ivan, autistic developer | Accept | Section ids must be explicit and stable for every page |
| Ellie, ADHD student | Accept | Kanban needs a dedicated Lanes tab because lane management is not secondary detail |
| Marcus, working-memory constrained developer | Accept | Calendar needs a visible Overview tab before the month grid |
| Fiona, ADHD PM | Accept | Table needs filters and fields separated so column controls do not fight saved filters |
| Liam, ADHD entrepreneur | Accept | A shared shell only works if task-detail handoff and new-task flows remain identical everywhere |

## Task Management, GTD, And Todo Product Panel

| Persona | Verdict | Recommendation |
| --- | --- | --- |
| David Allen lens | Accept | Today should separate capture, clarify, and do-now states instead of one long scrolling queue |
| Todoist product lens | Accept | Upcoming must preserve fast completion directly from the list |
| Linear product lens | Accept | Kanban and Table can share shell language without losing the task-view route switcher |
| TickTick product lens | Accept | Calendar should expose the month view and day detail as separate shell sections |
| Notion operations lens | Accept | Flow tabs should explain how each page hands work to the other surfaces |
| OmniFocus lens | Accept | Today needs a strong Work tab instead of raw list sprawl |
| Things 3 lens | Accept | Overview sections should be calm, short, and visibly separate from dense work surfaces |
| Sunsama lens | Accept | Calendar should keep sync and planning controls in the shell, not buried in the grid |
| Asana portfolio lens | Accept | Table needs an Overview section summarizing counts before filters and fields |
| Basecamp simplicity lens | Accept | The shell should reduce topbar noise, not recreate it with too many competing utilities |

## Habits And Behavior Design Panel

| Persona | Verdict | Recommendation |
| --- | --- | --- |
| James Clear lens | Accept | Today should present Focus before Work so the next action is visible immediately |
| BJ Fogg lens | Accept | Upcoming completion controls must stay tiny and direct |
| Charles Duhigg lens | Accept | Cross-page flow explanations should make cue-routine-reward visible between pages |
| Nir Eyal lens | Defer | Do not add extra behavioral prompts during shell migration; keep scope to structure |
| Atomic Habits coaching lens | Accept | Habits influence Today and Upcoming, so Flow sections must reference those handoffs explicitly |
| Executive function coaching lens | Accept | Overview tabs should answer “where am I and what matters here?” in one glance |
| Streak design lens | Accept | Calendar must not hide daily workload under pure month chrome |
| Reflective planning lens | Accept | Upcoming and Calendar need explicit links back to Today |
| Routine systems lens | Accept | Do not fork a second habit-tracking metaphor into Today; keep routines as shared task outputs |
| Minimal-friction behavior lens | Accept | Shell actions must stay stable across all pages to preserve muscle memory |

## Agile, Kanban, And Flow Systems Panel

| Persona | Verdict | Recommendation |
| --- | --- | --- |
| Kanban coach | Accept | Kanban needs lanes surfaced as first-class context, not hidden behind settings-like affordances |
| Scrum master lens | Accept | Table and Kanban should preserve cross-view switching because each route is a distinct planning mode |
| Flow efficiency lens | Accept | Calendar flow should connect month planning to Today execution |
| Jira admin lens | Accept | Card field controls belong in a named section, not as an always-on competing action |
| Lean ops lens | Accept | Overview sections should summarize constraints before users enter dense work views |
| Program board lens | Accept | Kanban Flow should carry users into Table and Calendar with existing query context |
| Portfolio planning lens | Accept | Table Overview should summarize workload, not just drop users into raw rows |
| WIP management lens | Accept | Today and Kanban should preserve their current high-signal actions, not bury them under general shell chrome |
| Systems thinking lens | Accept | Calendar and Upcoming should treat adjacency links as operational flow, not decoration |
| Agile delivery lens | Accept | Roll out the shell page by page instead of one large concurrent surface rewrite |

## Home Assistant, Local-First, Companion, And Ingress Panel

| Persona | Verdict | Recommendation |
| --- | --- | --- |
| Home Assistant frontend lens | Accept | Keep same-route hashes and avoid anything that risks ingress escape |
| Companion app lens | Accept | Secondary route-switch tabs are fine if they keep query strings and ingress paths intact |
| Add-on UX lens | Accept | The shell should complement HA’s top-level navigation by staying calm and horizontal |
| Assist integration lens | Accept | `ask-ha-btn` must remain identical across all shell pages |
| SearchHub lens | Accept | No local search inputs; every page launches the same SearchHub surface |
| Local-first reliability lens | Accept | Controller extraction is mandatory before shell rollout on Upcoming and Calendar |
| Offline safety lens | Accept | Section navigation must degrade gracefully even if background APIs fail |
| Mobile companion lens | Accept | Today and Upcoming must avoid a second nav row on narrow screens |
| Ingress compatibility lens | Accept | Companion deeplinks should remain structurally valid even when only Settings exposes copy/open UI |
| HA publishing lens | Accept | The shell program must land with docs, runbook notes, and explicit verification language |

## Top Recommendations

1. Two-layer shell for Calendar, Kanban, and Table
2. Single-layer shell for Today and Upcoming
3. Explicit Flow section on every page
4. Overview-first IA before dense work surfaces
5. Controller extraction before shell work on Upcoming and Calendar

## Rejected Or Deferred Ideas

1. Merge task-view routing into unified-bar tabs: rejected
2. Add page-local search inputs: rejected
3. Add per-page companion action UI everywhere during shell migration: deferred
4. Expand scope to Gantt shell work in the same slice: deferred
