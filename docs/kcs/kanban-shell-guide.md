# Kanban Shell Guide

## What Changed

Kanban now uses the unified shell above the existing task-view strip while keeping board-first controls close to the board itself.

The Kanban shell sections are:

- `#kanban-overview`
- `#kanban-lanes`
- `#kanban-fields`
- `#kanban-flow`

The shell keeps `Manage Lanes`, SearchHub, Assist, and the shared new-task entry point, while field customization now lives in the dedicated `Fields` section instead of crowding the shell.

## Common Jobs

### Manage lanes without leaving the board

1. Open `Kanban`.
2. Use the shell `Manage Lanes` action.
3. Keep the board visible while editing lane structure and WIP limits.

### Change card density without fighting the shell

1. Jump to `Fields`.
2. Use the card customizer there instead of expecting field toggles in the shell.
3. Return to `Lanes` when you are ready to work the board again.

### Switch task views and keep the current query

1. Apply the Kanban filters you need.
2. Use `TaskViewTabs` to move to Calendar or Table.
3. Confirm the target route keeps the same query string.

## Troubleshooting

### Board updates fail behind ingress

1. Inspect the browser console for `kanban` client logger warnings.
2. Confirm client fetches are using bare `/api/...` paths and not double-prefixed ingress URLs.

### Manage Lanes does not open

1. Confirm `#lane-mgmt` drops the `hidden` class after clicking `Manage Lanes`.
2. If the button responds but the panel stays hidden, capture the browser console and the current filter state.
