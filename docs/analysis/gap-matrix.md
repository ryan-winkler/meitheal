# Search Gap Matrix

**Domain:** Universal search, task search, navigation, and command actions
**Updated:** 2026-03-15
**Baseline:** Verified against Meitheal codebase, Teamhood screenshot supplied in-thread, and current official docs for Linear, ClickUp, Jira, and Todoist

## Competitor Set

The repo historically references Teamhood, Linear, ClickUp, Jira, Asana, Todoist, TickTick, Vikunja, and Super Productivity. This baseline focuses on the search capabilities we could verify directly and turns the rest into follow-up documentation work rather than guessing.

## Capability Matrix

| Capability | Meitheal (before) | Teamhood | Linear | ClickUp | Jira | Todoist | Gap |
|---|---|---|---|---|---|---|---|
| One primary search surface | Split between topbar search and command palette | Yes | Yes | Yes | Yes | Yes | High |
| Search beyond task title/description | No | IDs, titles, descriptions, custom fields, comments | Rich filter operators and templates | Command Center spans multiple object types | JQL/basic search spans issue fields and saved filters | Custom filters span priority, labels, due dates, assignees | High |
| Cross-object search | No | Work items and views | Issues, projects, views | Tasks, docs, dashboards, whiteboards, chat | Issues, projects, boards, filters | Filters/projects/labels | High |
| Saved views / filters surfaced in search | No | Yes | Yes | Yes | Yes | Yes | High |
| Keyboard-first launch | Inconsistent (`Cmd/Ctrl+K` opens a different tool than the visible search box suggests) | Yes | Yes | Yes | Yes | Yes | High |
| Direct actions from search | Limited | Yes | Yes | Yes | Yes | Limited | Medium |
| Completed toggle in search | No | Yes | Yes | Yes | Yes | Yes | High |
| Archived toggle in search | No meaningful archive UX | Yes | Varies by object state | Varies | Yes | N/A | Medium |
| Settings / navigation search | Separate settings-only search | N/A | Yes | Yes | Yes | Project/filter navigation | Medium |
| Home Assistant-aware results | No | N/A | N/A | N/A | N/A | N/A | Meitheal differentiator |

## Immediate Actions

1. Replace the split topbar search + command palette behavior with one search hub launched from the topbar and `Cmd/Ctrl+K`.
2. Add a dedicated `/api/search` contract for universal search, leaving `/api/tasks` focused on task listing/filtering.
3. Upgrade task search to support ticket keys/IDs, labels, custom fields, comments, and completed/archive toggles.
4. Surface boards, saved filters, settings anchors, and quick actions in the same search experience.
5. Make search Home Assistant-native by exposing HA-aware actions like Ask Assistant and ingress-safe deep links.
6. Keep implementation Astro-native by using SSR + vanilla TypeScript controllers instead of SPA islands or client framework state.

## Explicit Deferrals

1. Full Home Assistant entity/service search is out of scope for this pass.
2. True archive lifecycle parity is deferred until archive semantics are first-class in Meitheal instead of being mostly synonymous with completion.
3. Natural-language filter syntax is deferred; structured chips and scoped fields come first.
