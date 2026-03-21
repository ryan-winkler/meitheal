# Pillars Domain — Features Research (Expanded Scope)

**Date:** 2026-03-21 (v2 — expanded with Principles, AI, Strategy, UX)
**Researcher:** Antigravity (50-persona audit + integration analysis)

## Table Stakes (Must-Have for V1)

| Feature | Description | Source |
|---------|-------------|--------|
| **Pillar CRUD** | Create, edit, delete, reorder Pillars | User spec + 50/50 personas |
| **Principle/Non-Negotiable CRUD** | Create, edit, delete child Principles per Pillar | User spec (LOCKED) |
| **Name + Icon + Color** | Visual identity per Pillar | 48/50 personas |
| **Max 7 soft limit** | Cognitive load guard with warning (not block) | 42/50 personas |
| **Identity framing** | "I am someone who..." placeholders | User spec (LOCKED), 38/50 |
| **Shame-free design** | No failure states, only positive anchors | User spec (LOCKED), 46/50 |
| **Goal linkage** | M2M via `pillar_associations` (entity_type=goal) | User spec + 47/50 |
| **Routine linkage** | M2M via `pillar_associations` (entity_type=routine) | User spec + 45/50 |
| **North Star page** | Large masonry-grid or manifesto-style Pillar cards | User spec (LOCKED) |
| **Blueprint view** | Click Pillar → see WHY, Principles, linked Goals/Routines/Tasks | User spec (LOCKED) |
| **Top-down inheritance** | Tasks inherit Pillar from parent Project → Goal chain | User spec (LOCKED) |
| **Orphaned task visual** | "Unaligned" flag on tasks without Pillar (gamification, not shame) | User spec (LOCKED) |

## Should-Have (V1 if time allows)

| Feature | Description | Source |
|---------|-------------|--------|
| **AI prompt injection** | Principles injected into LLM system prompt via `ai-context-service.ts` | User spec (LOCKED) |
| **Conflict resolution UI** | Non-blocking "Boundary Conflict" warning when scheduling violates Principle | User spec (LOCKED) |
| **Strategic evaluator boost** | Pillar-weighted priority pre-computation in `rule-resolver.ts` | User spec (LOCKED) |
| **Alignment audit chart** | Weekly balance visualization across Pillars in `progress.astro` | User spec |
| **AI onboarding wizard** | Behavioral questions → AI drafts Pillars and Principles | User spec (LOCKED) |

## Differentiators (V2+)

| Feature | Description |
|---------|-------------|
| **Pillar attention radar** | N-sided polygon visualization showing time balance |
| **HA sensors** | `sensor.meitheal_pillar_{slug}_attention` |
| **Pillar filter chips** | Filter any task view by Pillar |
| **Household Pillar sharing** | Shared vs. personal Pillars |
| **Calendar color-coding** | Timeline events tinted by Pillar color |
| **WebMCP Principle access** | External agents query Principles via MCP |
| **Node-RED/n8n triggers** | Automation on Principle violations |

## Anti-Features (Explicitly NOT building)

| Feature | Reason |
|---------|--------|
| Pillar streak counter | Shame-inducing. Pillars are permanent, not performative. |
| Pillar failure notifications | "You haven't served Health" = harmful for ADHD. |
| Mandatory Pillar assignment | Tasks without Pillars are fine. Gentle "unaligned" flag only. |
| Sub-pillars / hierarchy | Pillars are flat. Principles are children. No nesting beyond that. |
| Hard-block on conflicts | Life happens. Warning only, always dismissible. |
| Complex Principle scheduling | Principles are rules, not calendar events. |

## Competitive Landscape

| App | Values/Pillars? | Principles/Boundaries? | AI Integration? |
|-----|-----------------|----------------------|-----------------|
| TickTick | ❌ | ❌ | ❌ |
| Todoist | ❌ | ❌ | ✅ (basic AI) |
| Habitica | ❌ | ❌ | ❌ |
| Things 3 | ❌ | ❌ | ❌ |
| OmniFocus | ❌ | ❌ | ❌ |
| Notion | ⚠️ DIY | ⚠️ DIY | ✅ (AI) |
| Serenity Coach | ✅ Values | ❌ | ❌ |
| maLife | ✅ Vision | ❌ | ❌ |

**No competitor combines structured Pillars + behavioral Principles + AI enforcement.** This is a genuine differentiator.

## Confidence: HIGH
Features validated by 50-persona panel, competitive gap analysis, and detailed user specification with LOCKED decisions.
