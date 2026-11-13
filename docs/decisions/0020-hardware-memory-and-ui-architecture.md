---
type: "Decision"
title: "Hardware, Memory, and UI Surface Architecture"
description: "Scopes Home Assistant entity state, streams Ingress HTML, bounds SQLite read/write concurrency, standardizes Evergreen Carbon surfaces and 64-icon Tabler sprites, and virtualizes the SVG timeline without changing schema 18."
---

# ADR 0020: Hardware, Memory, and UI Surface Architecture

Date: 2026-11-13
Status: Accepted

## Context

Meitheal runs as a local-first Home Assistant Supervisor add-on (`meitheal-hub` and `meitheal-hub-canary`) alongside Home Assistant Core, Zigbee2MQTT, and other services on constrained single-board computers (Home Assistant Green, Home Assistant Yellow, and 2 GiB Raspberry Pi 4 hosts). Runtime profiling identified six bottlenecks:

1. Unfiltered Home Assistant WebSocket state caching retained 1,000 to 5,000+ unrelated entities (`25-60 MiB` V8 heap) and shallow-cloned the state map on every tick.
2. Home Assistant Supervisor Ingress HTML rewriting pre-buffered responses up to `5 MiB` and ran regular expressions that could mutate `<script>` JSON payloads or duplicate prefixes.
3. Cold boot overlapped Home Assistant hydration, Todo/Calendar/Grocy syncs, and runtime `openapi.yaml` parsing inside a `128 MiB` Old Space ceiling, while Stage 3 shipped unused `sharp` and `drizzle-orm` packages.
4. Shared task view queries loaded full checklists and historical rows into JavaScript, opened a fresh SQLite handle on every read snapshot, re-compiled `SELECT total_changes()` on writes, and ran unchunked sync transactions.
5. `domain-observability` filtered out `warn` and `error` events for unlisted log categories, and the reference Alloy collector (`config.river`) overwrote JSON log lines with plain text.
6. Twenty-four CSS and component files used `backdrop-filter` blur rules, twenty-nine UI chrome files kept legacy `#6366f1`/`#7c3aed` fallbacks, static chrome mixed Unicode emojis with inconsistent inline SVGs, `TaskDetailModal.astro` used viewport media queries instead of `@container` rules, and 500-task GANTT timelines mounted over 6,000 DOM nodes.

## Decision

We adopt a four-track architecture while keeping `DATABASE_SCHEMA_VERSION = 18` for zero-downtime image rollback:

1. **Track A (Scoped Gateway State, Streaming Ingress, Precompilation & Telemetry)**:
   - Scope `domains/ha/ha-entities.ts` to enabled `calendar.*`, `todo.*`, and explicit `onEntityChange` listener IDs seeded via `config/entity_registry/list` plus a one-time startup `get_states` scan (capturing YAML entities without `unique_id`), refreshed dynamically via `entity_registry_updated`, `component_loaded`, WebSocket reconnect, and listener registration without subscribing to unfiltered `state_changed` events (`< 1.5 MiB` retained cache).
   - Stream every `text/html` Ingress response directly through `parse5-html-rewriting-stream` using streaming UTF-8 decoding and idempotent URL prefixing across `href`, `src`, `action`, and `srcset` attributes while leaving `<script>`, `<style>`, `<textarea>`, and `data-*` untouched.
   - Precompile MCP OpenAPI tool schemas (`src/generated/mcp-tools.json`) and remove `sharp` and `drizzle-orm` from production dependencies. Size V8 Old Space via `resolve_max_old_space_mb()` (`MEITHEAL_MAX_OLD_SPACE_MB >= 96` override; `55%` clamped to `[96, 160]` on bounded cgroups such as `105 MiB` under the `192 MiB` Green Canary cap; `128 MiB` default on unbounded hosts) and extend `/api/health` startup polling to 45 seconds with PID liveness checks.
   - Bypass category filters on `warn` and `error` logs, preserve intact JSON lines in `config.river` under 5 fixed Loki labels (`addon`, `service`, `env`, `level`, `domain`), emit a 60-second `runtime.vitals` heartbeat, and expose `GET /api/diagnostics` exclusively to verified Home Assistant administrators or standalone local operators.

2. **Track B (SQLite Read Reuse, View SQL Pushdown, Chunked Savepoint Syncs & Route Hardening)**:
   - Keep `node:sqlite` `DatabaseSync` non-blocking (`{ timeout: 0 }`, `PRAGMA synchronous = FULL`, `2 MiB` writer cache), cache one `SELECT total_changes()` statement per handle, reuse at most one auto-closing (`30 s` idle TTL, `512 KiB` cache) read-only handle for `BEGIN DEFERRED` snapshots, and apply `AbortSignal`-aware async JS retry backoff (`[5, 15, 30, 60, 120]` ms).
   - Push task view filters, status/project counts, and scalar checklist summaries (`checklist_total`, `checklist_done`, `has_description`) into SQL, and commit inbound Todo, Calendar, and Grocy sync batches in `<= 25`-item transactions with `setImmediate` yields and per-item `SAVEPOINT` isolation.
   - Attach a 25-second `writeAbortSignal` to mutating `/api/*` requests, reject encoded path separators (`%2f`, `%5c`, `%00`) and `.` / `..` segments on raw `/api/*` paths before `?`, validate MCP path segments across generic and custom handlers, and keep IP rate limiting ahead of SQLite token verification for external callers while isolating per-token rate budgets (`token:<tokenId>`).

3. **Track C (Evergreen Carbon Opaque Surfaces, Build-Extracted Tabler Catalog & 5-Bucket Emoji Policy)**:
   - Enforce `0` `backdrop-filter`/`backdrop-blur-*` rules and `0` `#6366f1`/`#7c3aed` UI chrome literals (outside the 13 user-swatch and entity-default files), binding `var(--accent)` directly in CSS over the Evergreen Carbon + Living Mint (`#101210` / `#69E3B2`) and Warm Paper + Forest Emerald (`#F6F5F0` / `#146C4E`) token palette with `Geist Variable` and `JetBrains Mono`.
   - Extract a build-time typed 64-icon `1.75px` Tabler outline registry (`src/generated/icon-registry.ts`), sprite `<Icon sprite={true} />` and `<TaskTypeIcon />` through streaming-safe `<IconSpriteDefs />`, and apply the 5-Bucket Emoji Safety Policy so bidirectional sync markers, user entity icons, pickers, and native `<select><option>` labels remain intact while static UI chrome uses outline icons.

4. **Track D (`@container` Workspace Inspector & Virtualized SVG GANTT)**:
   - Convert `TaskDetailModal.astro` to CSS `@container` queries, resolve `MTH-N` keys in `GET /api/tasks/[id]`, dock a `420px` right inspector pane at `>= 1440px` without locking `body` scroll or suppressing SearchHub/shortcuts, and wire Ingress-stripped route persistence (`/tickets/<key>`) across 60-second Home Assistant Ingress reloads.
   - Virtualize `.gantt-sidebar-track` and `svg.gantt-native` rows in a unified `requestAnimationFrame` window (`<= 60` mounted bar groups, `<= 450` timeline DOM nodes at 500 tasks) with SVG `<pattern>` day/week grids, 1st-of-month `Month` dividers, active drag/focus retention, and `data-row-index`-aware PNG export.

## Alternatives Rejected

1. **In-process Rust / WebAssembly (`wasm-bindgen`) or `napi-rs` native addons**: UTF-16/UTF-8 string marshalling and Alpine `musl` prebuild maintenance add overhead compared to pushing predicates and projections into `node:sqlite` C queries.
2. **`gpui-web` (WASM + WebGPU) or standalone `gpui.rs` client**: Requires `[SecureContext]` (`navigator.gpu`, unavailable on `http://homeassistant.local:8123`) and breaks Astro SSR, Ingress link rewriting, and Companion WebViews.
3. **WebGPU or Canvas2D timeline renderer**: Breaks native DOM focus rings, screen-reader row semantics, CSS tokens, and Playwright bar selectors.
4. **Custom sliding-tail regex `TransformStream` for Ingress HTML**: Cannot safely track `<script>`, `<style>`, or `<textarea>` rawtext across arbitrary chunk splits.
5. **SQLite FTS5 virtual table and Schema `19`**: Household catalogs (`10^2-10^4` tasks) scan via `instr()` in `1-4 ms`; FTS5 adds trigger write amplification and breaks rollback to schema `18` images.
6. **Floating-point (`REAL`) Kanban positions**: IEEE-754 midpoint division underflows after 53 repeated top-of-lane insertions.
7. **C-level `DatabaseSync({ timeout: 5000 })`, `PRAGMA synchronous = NORMAL`, or `statement.run().changes`**: Blocks the Node.js event loop, risks power-loss WAL tail loss, and breaks DDL `rowsAffected === 0` contracts.
8. **Custom `zlib`/Zstd HTTP compression in `serve.mjs` or `content-visibility: auto` on task tables**: Home Assistant Ingress strips content encoding while extra stream buffers raise RSS, and `content-visibility: auto` collapses off-screen `DOMRect` geometry.
9. **Dedicated `worker_threads` SQLite pool**: Each extra V8 isolate adds `25-40 MiB` baseline RSS inside a `128 MiB` idle budget.
10. **Per-entity `subscribe_trigger` or unfiltered `state_changed` subscriptions**: Either multiplies WebSocket subscriptions or streams every unrelated sensor state tick into Node.js.

## References

- [Operations Runbook](../kcs/operations-runbook.md)
- [Green Canary Benchmark](../kcs/green-canary-benchmark.md)
- [Settings Outline Icons](../kcs/settings-outline-icons.md)
