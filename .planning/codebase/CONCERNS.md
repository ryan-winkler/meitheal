# Codebase Concerns

**Analysis Date:** 2026-03-20

## DDD Compliance Audit

### ✅ Strengths

**Zero cross-context violations detected.** No packages import directly from `@domains/` (the in-app layer). No deep imports bypass public APIs. The 5 domain packages (`domain-auth`, `domain-tasks`, `domain-strategy`, `domain-observability`, `integration-core`) and 16 in-app domains have clean boundaries.

### ⚠️ Concerns

**Controller Layer Lacks DDD Alignment:**
- Issue: View controllers (`kanban-controller.ts`, `today-controller.ts`, etc.) live in `@lib/` flat namespace, not in a UI domain context
- Files: `apps/web/src/lib/kanban-controller.ts`, `apps/web/src/lib/today-controller.ts`, etc.
- Impact: New controller code doesn't get DDD-guided placement — "where does this go?" is answered by "somewhere in lib"
- Fix approach: Create `apps/web/src/domains/ui/` or group controllers under `@lib/controllers/` with clear README boundaries

### ~~3. Orphaned API Routes~~ ✅ Partially Resolved
**Files:** See `.planning/codebase/INTEGRATION-CHECK.md`
**Issue:** 20+ API route files had zero discovered frontend consumers.
**Resolution:** Audited all 97 routes. Deleted 9 dead stubs (736 lines): backup/*, grocy/stock, ha/status, nfc/complete, parse-task, tasks/proposals, tasks/accept-proposal, today-summary. Remaining orphans documented as external-only (A2A, iCal export, review) or kept for future features.

**In-App Domain Inconsistency:**
- Issue: Some domains have proper service/repository layers (`tasks/`, `search/`, `ha/`), others are single-file modules (`gamification/`, `pomodoro/`, `offline/`)
- Files: `apps/web/src/domains/gamification/gamification-service.ts` (single file), `apps/web/src/domains/search/` (proper domain with catalog, registry, service)
- Impact: DDD "domain" label applied inconsistently — some are true bounded contexts, others are just utility modules
- Fix approach: Graduate mature single-file domains to proper structure, or reorganize thin ones as `@lib/` utilities

**Missing Domain Events:**
- Issue: Domain packages define events conceptually but there's no event bus implementation. Cross-domain coordination uses direct imports or REST calls
- Files: `packages/domain-tasks/`, `packages/integration-core/`
- Impact: No event-driven decoupling between task lifecycle and integrations (calendar sync, gamification, search index)
- Fix approach: Introduce a lightweight event emitter in `integration-core` or use Astro's built-in module communication

---

## Astro-First Architecture Audit

### ✅ Strengths

- **Pure SSR mode** (`output: "server"`) — no client islands (`client:*` directives = 0)
- **23 Astro pages**, 99 API routes — proper Astro routing
- **No framework dependencies** — `integrations: []` in astro config, clean Astro
- **`serve.mjs` ingress wrapper** — Astro-native HTTP handling

### ⚠️ Concerns

**Heavy Client-Side Controllers:**
- Issue: 6 view controllers (5,176 lines total after decomposition) run as `<script>` blocks, not Astro components. All UI logic is client-side JavaScript, effectively an SPA inside Astro SSR
- Files: `apps/web/src/lib/kanban-controller.ts` (592 lines), `apps/web/src/lib/today-controller.ts` (934 lines)
- Impact: Astro's SSR strength (HTML-first, progressive enhancement) is underutilized. The entire UI is client-rendered
- Fix approach: Gradually migrate read-only views to server-rendered Astro components with hydration. Keep interactive elements as scripts

**No Astro Islands:**
- Issue: Zero `client:load`, `client:visible`, `client:idle`, or `client:only` directives found. All interactivity is via global `<script>` tags
- Files: All `.astro` pages
- Impact: Missing Astro's partial hydration advantage — everything loads and hydrates at once
- Fix approach: Identify read-only sections (stats panels, task lists) that can server-render, then use `client:visible` for interactive widgets

**No Astro Content Collections:**
- Issue: Static content (help docs, onboarding, KCS articles) is hardcoded in components
- Impact: Missing chance to use Astro's content collection pipeline for docs, changelogs, help articles
- Fix approach: Move help text and KCS content to `src/content/` collections

---

## HA Native Integration Audit

### ✅ Strengths

- **Full custom component** with config flow, coordinator, sensors, todo entity, device triggers, intents, LLM API, MCP server, services, diagnostics, repairs, backup, icons
- **21 LLM tools** in `llm_api.py` — rich voice/conversation surface including daily briefing, goals, areas, hierarchy
- **HA Supervisor API** access with `hassio_role: manager`
- **Ingress-first architecture** — 336 ingress references, deep HA embedding
- **`ha-theme-bridge.ts`** syncs HA CSS vars

### ⚠️ Concerns

**MCP Server Divergence:**
- Issue: HA Python MCP server (`mcp_server.py`, 524 lines) and Astro TS MCP server (`api/mcp.ts`, 589 lines) define overlapping but different tool sets. Python has `meitheal_list_areas`, `meitheal_list_goals`, `meitheal_move_task`, `meitheal_set_goal_progress` that TS lacks
- Files: `integrations/home-assistant/custom_components/meitheal/mcp_server.py`, `apps/web/src/pages/api/mcp.ts`
- Impact: External MCP clients (Antigravity, Claude) get different capabilities depending on connection path
- Fix approach: Generate both from a shared tool registry, or make TS MCP the canonical source and have Python delegate

**HA Entity Coverage Gap:**
- Issue: Only 1 entity platform (`todo.py`). No sensors for task counts, habit streaks, or overdue counts. The `sensor.py` file exists but may be limited
- Files: `integrations/home-assistant/custom_components/meitheal/sensor.py`, `integrations/home-assistant/custom_components/meitheal/todo.py`
- Impact: HA dashboard cards, automations, and voice can't easily reference "how many tasks are overdue?" as entity states
- Fix approach: Add sensor entities for `active_tasks`, `overdue_tasks`, `habit_streak`, `weekly_velocity`

**Intent Coverage Minimal:**
- Issue: `intents.py` and `custom_sentences/` exist but likely cover only basic intents
- Files: `integrations/home-assistant/custom_components/meitheal/intents.py`
- Impact: Native HA voice ("Hey Google, what's on my task list?") may not work without rich intent handlers
- Fix approach: Expand sentence triggers to cover the full LLM tool surface

---

## MCP / A2A / LLM Integration Audit

### ✅ Strengths

- **Three parallel AI integration surfaces:**
  - HA LLM API (21 tools) — voice assistants, HA Conversation agents
  - Astro MCP server (17 tools) — external AI clients via JSON-RPC
  - A2A protocol handler (11 skills) — agent-to-agent communication
- **`.well-known/mcp.json` discovery** — standards-compliant
- **A2A Agent Card** with dynamic skill inclusion based on HA configuration
- **`ai-context-service.ts`** + `ha-assist-service.ts` in `domains/ai/`

### ⚠️ Concerns / Opportunities

**A2A Skill Handlers Are Stubs:**
- Issue: `a2a-handler.ts` defines skill types and routing but actual execution handlers aren't implemented. `extractSkillFromMessage()` routes by keyword matching but there's no handler registry executing the skills
- Files: `packages/integration-core/src/a2a-handler.ts`
- Impact: A2A clients can discover Meitheal's agent card but can't actually execute skills
- Fix approach: Wire A2A skill handlers to the same internal API that MCP uses. Create a shared `ToolRegistry` that both MCP and A2A consume

**MCP Protocol Version Behind:**
- Issue: MCP server reports `protocolVersion: "2024-11-05"` — check if newer spec versions exist
- Files: `apps/web/src/pages/api/mcp.ts:246`
- Impact: Newer MCP clients may expect features from later protocol versions
- Fix approach: Review MCP spec changelog and update if needed

**No MCP Resources or Prompts:**
- Issue: MCP server only exposes `tools`. No `resources` (task collections, habit templates) or `prompts` (task creation templates, daily briefing prompts) exposed
- Files: `apps/web/src/pages/api/mcp.ts`
- Impact: Missing MCP capability that would let AI clients browse task data natively without tool calls
- Fix approach: Add `resources/list` handler exposing task lists, habit templates, and area trees as MCP resources

**No Streaming / SSE for MCP or A2A:**
- Issue: Both MCP and A2A use synchronous request/response. No SSE streaming for long operations (bulk imports, calendar sync)
- Files: `apps/web/src/pages/api/mcp.ts`, `packages/integration-core/src/a2a-handler.ts`
- Impact: Long-running operations block the response. Modern MCP clients expect streaming support
- Fix approach: Add SSE transport option for MCP; implement A2A `tasks/sendSubscribe` for streaming updates

**No Agent Orchestration Layer:**
- Issue: Each AI surface (MCP, A2A, LLM) implements its own tool->API routing independently. No shared orchestration layer
- Files: `apps/web/src/pages/api/mcp.ts` (inline switch), `integrations/home-assistant/custom_components/meitheal/llm_api.py` (class per tool)
- Impact: Tool additions require changes in 3 places. Business logic duplicated across surfaces
- Fix approach: Create `packages/integration-core/src/tool-registry.ts` as single source of truth. MCP, A2A, and LLM all consume from registry

**Hierarchy Tools Missing from MCP TS:**
- Issue: HA LLM has `meitheal_list_areas`, `meitheal_list_goals`, `meitheal_move_task`, `meitheal_set_goal_progress` that the Astro MCP TS endpoint lacks entirely
- Files: Compare `integrations/home-assistant/custom_components/meitheal/llm_api.py` vs `apps/web/src/pages/api/mcp.ts`
- Impact: External AI clients can't manage areas/goals via MCP
- Fix approach: Add missing tools to MCP TS, ideally via shared registry

---

## Test Coverage Gaps

**No integration tests for MCP/A2A:**
- Files: `apps/web/src/pages/api/mcp.ts`, `packages/integration-core/src/a2a-handler.ts`
- Risk: Breaking changes to AI integration surfaces go undetected
- Priority: Medium — critical integration surface with no test coverage

**No E2E tests for ingress flow:**
- Files: `apps/web/scripts/serve.mjs`, `apps/web/src/middleware.ts`
- Risk: Ingress regressions only caught in Tier 2 devcontainer
- Priority: Medium

---

*Concerns audit: 2026-03-20*
